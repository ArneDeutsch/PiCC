import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import picc from "../src/index.js";
import { fakePi, type FakePi } from "./helpers/fake-pi.js";
import { fakeSdk, type FakeCustomTool, type FakeSdkHandle } from "./helpers/fake-sdk.js";
import { cleanupFixture, materializeFixture } from "./helpers/fixture.js";

/**
 * `NotebookRead` is retired to a degrade-stub (notebook reading merged into
 * `Read`, which renders `.ipynb` cell-aware — see notebook-render.ts). The name
 * must STILL resolve/gate cleanly so existing deny/allow/`tools:` references and
 * subagent grants keep working, but a call must now return the redirect notice
 * (never silently run the old parser, never hard-error as unknown).
 *
 * `gateTools` filters an agent's grant against `allKnownToolNames()`; the name is
 * now supplied by the `DEGRADED_TOOLS` spread (no standalone literal). This test
 * dispatches an all-tools-inheriting subagent and asserts a `NotebookRead`
 * customTool actually reached the created subagent session — it fails iff the
 * name is missing from `allKnownToolNames()` — and that executing the granted
 * stub returns the redirect notice rather than parsed notebook content.
 */

let dir: string;
let pi: FakePi;
let h: FakeSdkHandle;
const originalCwd = process.cwd();
const originalUserDir = process.env.PICC_CLAUDE_USER_DIR;

function createMainSession(cwd: string): string {
  const manager = SessionManager.create(cwd, cwd);
  manager.appendMessage({ role: "user", content: "parent" } as never);
  manager.appendMessage({ role: "assistant", content: [], stopReason: "stop" } as never);
  return manager.getSessionFile()!;
}

beforeAll(async () => {
  dir = materializeFixture("full-surface");
  const userDir = path.join(dir, ".claude-user");
  fs.mkdirSync(userDir, { recursive: true });
  process.env.PICC_CLAUDE_USER_DIR = userDir;
  process.chdir(dir);

  h = fakeSdk({
    onPrompt: async () => "OK",
  });

  pi = fakePi();
  picc(pi.api as never, { sdk: h.sdk, onInitializationSettled: pi.captureInitialization });
  await pi.waitForInitialization();
  await pi.waitForTools(["bash", "read", "write", "edit", "grep", "find", "ls"]);
});

afterAll(() => {
  process.chdir(originalCwd);
  if (originalUserDir === undefined) delete process.env.PICC_CLAUDE_USER_DIR;
  else process.env.PICC_CLAUDE_USER_DIR = originalUserDir;
  cleanupFixture(dir);
});

describe("NotebookRead degrade-stub subagent-dispatch wiring", () => {
  it("registers the NotebookRead name on the main session (as a gating-token stub)", () => {
    expect(pi.tools.has("NotebookRead")).toBe(true);
  });

  it("a main-session NotebookRead call returns the redirect notice, not parsed content", async () => {
    const tool = pi.tools.get("NotebookRead");
    const res = await tool.execute("c1", { notebook_path: "whatever.ipynb" });
    const text = (res.content[0] as { text: string }).text;
    // Redirect notice: points at Read, conveys no capability lost, and — because
    // it is a redirect stub — omits the generic "Proceed without it." tail.
    expect(text).toContain("The NotebookRead tool is not available in PiCC");
    expect(text).toContain("read the notebook with Read instead");
    expect(text).toContain("no capability is lost");
    expect(text).not.toContain("Proceed without it.");
    // It did NOT run the old parser: no cell-render headers leak through.
    expect(text).not.toContain("=== Cell ");
    expect(res.details.degraded).toBe(true);
  });

  it("grants one real NotebookEdit per child and shares it only with that child's Read", async () => {
    const notebookPath = path.join(dir, "dispatch-notebook.ipynb");
    fs.writeFileSync(notebookPath, JSON.stringify({
      cells: [{ cell_type: "code", id: "child-cell", metadata: {}, source: "old", execution_count: null, outputs: [] }],
      metadata: {}, nbformat: 4, nbformat_minor: 5,
    }), "utf8");
    const agentTool = pi.tools.get("Agent");

    await agentTool.execute("child-a", {
      subagent_type: "future-agent", prompt: "first", run_in_background: false,
    });
    const firstTools = h.created.at(-1)!.customTools as FakeCustomTool[];
    const firstEdit = firstTools.find((tool) => tool.name === "NotebookEdit")!;
    const firstRead = firstTools.find((tool) => tool.name === "read")!;
    expect(firstTools.filter((tool) => tool.name === "NotebookEdit")).toHaveLength(1);
    for (const field of ["renderCall", "renderResult", "renderShell"] as const) {
      expect(firstEdit).not.toHaveProperty(field);
    }
    expect((await firstEdit.execute("before", {
      notebook_path: notebookPath, new_source: "blocked", cell_id: "child-cell",
    })).content[0]!.text).toContain("has not been successfully Read");
    await firstRead.execute("read", { path: notebookPath });
    expect((await firstEdit.execute("after", {
      notebook_path: notebookPath, new_source: "first-child", cell_id: "child-cell",
    })).content[0]!.text).toContain("Updated cell child-cell");

    await agentTool.execute("child-b", {
      subagent_type: "future-agent", prompt: "sibling", run_in_background: false,
    });
    const siblingEdit = (h.created.at(-1)!.customTools as FakeCustomTool[])
      .find((tool) => tool.name === "NotebookEdit")!;
    expect((await siblingEdit.execute("sibling-before", {
      notebook_path: notebookPath, new_source: "must-not-leak", cell_id: "child-cell",
    })).content[0]!.text).toContain("has not been successfully Read");
    fs.rmSync(notebookPath, { force: true });
  });

  it("keeps independent and degraded child starts unauthorized across the compact dispatch matrix", async () => {
    const notebookPath = path.join(dir, "matrix-notebook.ipynb");
    fs.writeFileSync(notebookPath, JSON.stringify({
      cells: [{ cell_type: "code", id: "matrix-cell", metadata: {}, source: "old", execution_count: null, outputs: [] }],
      metadata: {}, nbformat: 4, nbformat_minor: 5,
    }), "utf8");
    const assertUnauthorized = async (tools: FakeCustomTool[], label: string) => {
      const edit = tools.find((tool) => tool.name === "NotebookEdit");
      expect(edit, `${label} NotebookEdit grant`).toBeDefined();
      const result = await edit!.execute(label, {
        notebook_path: notebookPath, new_source: label, cell_id: "matrix-cell",
      });
      expect(result.content[0]?.text, label).toContain("has not been successfully Read");
    };
    try {
      const mainRead = await pi.tools.get("read").execute("matrix-main-read", { path: notebookPath });
      expect(mainRead.isError).not.toBe(true);
      await pi.tools.get("Agent").execute("matrix-ordinary", {
        subagent_type: "future-agent", prompt: "ordinary", run_in_background: false,
      });
      const ordinaryTools = h.created.at(-1)!.customTools as FakeCustomTool[];
      await assertUnauthorized(ordinaryTools, "ordinary");

      for (const agent of ["researcher", "isolated-worker"]) {
        await pi.tools.get("Agent").execute(`matrix-${agent}`, {
          subagent_type: agent, prompt: agent, run_in_background: false,
        });
        expect((h.created.at(-1)!.customTools as FakeCustomTool[])
          .some((tool) => tool.name === "NotebookEdit"), agent).toBe(false);
      }

      const ordinaryRead = await ordinaryTools.find((tool) => tool.name === "read")!
        .execute("ordinary-read", { path: notebookPath });
      expect(ordinaryRead.content.map((item) => item.text).join("\n")).toContain("matrix-cell");
      const nestedAgent = ordinaryTools.find((tool) => tool.name === "Agent")!;
      await nestedAgent.execute("matrix-nested", {
        subagent_type: "fork", prompt: "nested fork", run_in_background: false,
      });
      await assertUnauthorized(h.created.at(-1)!.customTools as FakeCustomTool[], "nested-fork");

      for (const mode of ["degraded-fork", "missing-api", "throwing-api"] as const) {
        const handle = fakeSdk({
          ...(mode === "degraded-fork" ? { noForkSessionManager: true } : {}),
          ...(mode === "throwing-api" ? { failCustomAppendAt: 1 } : {}),
          onPrompt: async () => "OK",
        });
        if (mode === "missing-api") {
          handle.sdk.inMemorySessionManager = () => ({});
        }
        const localPi = fakePi();
        picc(localPi.api as never, { sdk: handle.sdk, onInitializationSettled: localPi.captureInitialization });
        await localPi.waitForInitialization();
        await localPi.waitForTools(["read", "Agent"]);
        const modeMain = createMainSession(dir);
        await localPi.fire("session_start", { reason: "startup" }, localPi.ctx({
          sessionManager: {
            getSessionFile: () => modeMain,
            getBranch: () => [],
          },
        }));
        if (mode === "degraded-fork") {
          const localMainRead = await localPi.tools.get("read")
            .execute("degraded-fork-main-read", { path: notebookPath });
          expect(localMainRead.isError).not.toBe(true);
        }
        await localPi.tools.get("Agent").execute(`matrix-${mode}`, {
          subagent_type: mode === "degraded-fork" ? "fork" : "future-agent",
          prompt: mode,
          run_in_background: false,
        });
        const tools = handle.created.at(-1)!.customTools as FakeCustomTool[];
        await assertUnauthorized(tools, mode);
        if (mode !== "degraded-fork") {
          await tools.find((tool) => tool.name === "read")!.execute(`${mode}-read`, { path: notebookPath });
          const live = await tools.find((tool) => tool.name === "NotebookEdit")!.execute(`${mode}-edit`, {
            notebook_path: notebookPath, new_source: mode, cell_id: "matrix-cell",
          });
          expect(live.content[0]?.text).toContain("Updated cell matrix-cell");
          fs.writeFileSync(notebookPath, JSON.stringify({
            cells: [{ cell_type: "code", id: "matrix-cell", metadata: {}, source: "old", execution_count: null, outputs: [] }],
            metadata: {}, nbformat: 4, nbformat_minor: 5,
          }), "utf8");
        }
      }
    } finally {
      fs.rmSync(notebookPath, { force: true });
    }
  });

  it("keeps relative child Read and NotebookEdit aligned after dispatch-local worktree movement", async () => {
    await pi.tools.get("Agent").execute("moved-child", {
      subagent_type: "future-agent", prompt: "move", run_in_background: false,
    });
    const tools = h.created.at(-1)!.customTools as FakeCustomTool[];
    const enter = tools.find((tool) => tool.name === "EnterWorktree")!;
    const exit = tools.find((tool) => tool.name === "ExitWorktree")!;
    const entered = await enter.execute("enter", { name: "notebook-relative-child" });
    const worktreePath = String(entered.details?.worktreePath);
    const relativePath = "moved.ipynb";
    const absolutePath = path.join(worktreePath, relativePath);
    fs.writeFileSync(absolutePath, JSON.stringify({
      cells: [{ cell_type: "code", id: "moved-cell", metadata: {}, source: "old", execution_count: null, outputs: [] }],
      metadata: {}, nbformat: 4, nbformat_minor: 5,
    }), "utf8");
    try {
      const coordinatorRead = await pi.tools.get("read").execute("read-worktree-absolute", { path: absolutePath });
      expect(coordinatorRead.isError).not.toBe(true);
      const edit = tools.find((tool) => tool.name === "NotebookEdit")!;
      const unauthorized = await edit.execute("edit-relative-before-child-read", {
        notebook_path: relativePath, new_source: "must-not-write", cell_id: "moved-cell",
      });
      expect(unauthorized.content[0]!.text).toContain("has not been successfully Read");
      expect(JSON.parse(fs.readFileSync(absolutePath, "utf8")).cells[0].source).toBe("old");

      const childRead = await tools.find((tool) => tool.name === "read")!
        .execute("read-relative", { path: relativePath });
      expect(childRead.content.map((item) => item.text).join("\n")).toContain("moved-cell");
      const edited = await edit.execute("edit-relative", {
        notebook_path: relativePath, new_source: "moved-target", cell_id: "moved-cell",
      });
      expect(edited.content[0]!.text).toContain("Updated cell moved-cell");
      expect(JSON.parse(fs.readFileSync(absolutePath, "utf8")).cells[0].source).toBe("moved-target");
      expect(fs.existsSync(path.join(dir, relativePath))).toBe(false);
    } finally {
      await exit.execute("exit", { action: "remove" });
    }
  });

  it("restores a resumed child's own snapshot and copies main authorization only into a genuine fork", async () => {
    const notebookPath = path.join(dir, "persisted-child-notebook.ipynb");
    fs.writeFileSync(notebookPath, JSON.stringify({
      cells: [{ cell_type: "code", id: "persist-cell", metadata: {}, source: "old", execution_count: null, outputs: [] }],
      metadata: {}, nbformat: 4, nbformat_minor: 5,
    }), "utf8");
    const mainPath = createMainSession(dir);
    const mainBranch: unknown[] = [];
    const handle = fakeSdk({
      fakePersistedSessions: true,
      onPrompt: async () => "OK",
    });
    handle.sessionBranches().set(mainPath, mainBranch);
    const localPi = fakePi();
    picc(localPi.api as never, { sdk: handle.sdk, onInitializationSettled: localPi.captureInitialization });
    await localPi.waitForInitialization();
    await localPi.waitForTools(["read", "NotebookEdit", "Agent", "SendMessage"]);
    localPi.entries.length = 0;
    await localPi.fire("session_start", { reason: "startup" }, localPi.ctx({
      sessionManager: { getSessionFile: () => mainPath, getBranch: () => mainBranch },
    }));

    const started = await localPi.tools.get("Agent").execute("persist-child", {
      subagent_type: "future-agent", prompt: "first", run_in_background: false,
    });
    const childTools = handle.created.at(-1)!.customTools as FakeCustomTool[];
    await childTools.find((tool) => tool.name === "read")!.execute("child-read", { path: notebookPath });
    await localPi.tools.get("SendMessage").execute("resume-child", {
      to: String(started.details.agentId), message: "continue",
    });
    await handle.waitForPromptCalls(2);
    const resumedEdit = (handle.created.at(-1)!.customTools as FakeCustomTool[])
      .find((tool) => tool.name === "NotebookEdit")!;
    expect((await resumedEdit.execute("resumed-edit", {
      notebook_path: notebookPath, new_source: "resumed-child", cell_id: "persist-cell",
    })).content[0]!.text).toContain("Updated cell persist-cell");

    await localPi.tools.get("read").execute("main-read", { path: notebookPath });
    for (const entry of localPi.entries.filter((candidate) => candidate.customType === "picc-notebook-session")) {
      mainBranch.push({ type: "custom", customType: entry.customType, data: entry.data });
    }
    const forked = await localPi.tools.get("Agent").execute("fork-child", {
      subagent_type: "fork", prompt: "fork", run_in_background: false,
    });
    expect(forked.details.outcome).toBe("completed");
    const forkEdit = (handle.created.at(-1)!.customTools as FakeCustomTool[])
      .find((tool) => tool.name === "NotebookEdit")!;
    expect((await forkEdit.execute("fork-edit", {
      notebook_path: notebookPath, new_source: "fork-child", cell_id: "persist-cell",
    })).content[0]!.text).toContain("Updated cell persist-cell");
    fs.rmSync(notebookPath, { force: true });
  });

  it("restores only the last persisted child grant after a refresh append fails and still rejects changed bytes", async () => {
    const notebookPath = path.join(dir, "failed-persistence-notebook.ipynb");
    fs.writeFileSync(notebookPath, JSON.stringify({
      cells: [{ cell_type: "code", id: "failure-cell", metadata: {}, source: "old", execution_count: null, outputs: [] }],
      metadata: {}, nbformat: 4, nbformat_minor: 5,
    }), "utf8");
    const handle = fakeSdk({
      fakePersistedSessions: true,
      failCustomAppendAt: 2,
      onPrompt: async () => "OK",
    });
    const localPi = fakePi();
    picc(localPi.api as never, { sdk: handle.sdk, onInitializationSettled: localPi.captureInitialization });
    await localPi.waitForInitialization();
    await localPi.waitForTools(["read", "Agent", "SendMessage"]);
    const failureMain = createMainSession(dir);
    await localPi.fire("session_start", { reason: "startup" }, localPi.ctx({
      sessionManager: { getSessionFile: () => failureMain, getBranch: () => [] },
    }));
    const started = await localPi.tools.get("Agent").execute("failure-child", {
      subagent_type: "future-agent", prompt: "first", run_in_background: false,
    });
    const tools = handle.created.at(-1)!.customTools as FakeCustomTool[];
    await tools.find((tool) => tool.name === "read")!.execute("read", { path: notebookPath });
    const firstEdit = await tools.find((tool) => tool.name === "NotebookEdit")!.execute("edit", {
      notebook_path: notebookPath, new_source: "changed-without-refresh-entry", cell_id: "failure-cell",
    });
    expect(firstEdit.content[0]!.text).toContain("Updated cell failure-cell");

    await localPi.tools.get("SendMessage").execute("resume", {
      to: String(started.details.agentId), message: "continue",
    });
    await handle.waitForPromptCalls(2);
    const resumedEdit = (handle.created.at(-1)!.customTools as FakeCustomTool[])
      .find((tool) => tool.name === "NotebookEdit")!;
    const stale = await resumedEdit.execute("stale", {
      notebook_path: notebookPath, new_source: "must-not-write", cell_id: "failure-cell",
    });
    expect(stale.content[0]!.text).toContain("changed after the authorizing Read");
    expect(JSON.parse(fs.readFileSync(notebookPath, "utf8")).cells[0].source)
      .toBe("changed-without-refresh-entry");
    fs.rmSync(notebookPath, { force: true });
  });

  it("grants the NotebookRead stub to a subagent that inherits all tools, and it degrades on call", async () => {
    const agentTool = pi.tools.get("Agent");
    // future-agent has no `tools:` frontmatter → inherits ALL tools → is granted
    // NotebookRead. This exercises the allKnownToolNames wiring (name now supplied
    // by the DEGRADED_TOOLS spread) + the subagent grant block. Pin foreground so
    // the subagent session is created synchronously and its customTools inspectable.
    const res = await agentTool.execute("a1", {
      subagent_type: "future-agent",
      prompt: "go",
      run_in_background: false,
    });
    expect(res.details.outcome).toBe("completed");

    const granted = h.created.find((opts) =>
      ((opts.customTools as FakeCustomTool[]) ?? []).some((t) => t.name === "NotebookRead"),
    );
    expect(granted, "a dispatched subagent got a NotebookRead customTool").toBeDefined();

    const stub = (granted!.customTools as FakeCustomTool[]).find((t) => t.name === "NotebookRead")!;
    const call = await stub.execute("c2", { notebook_path: "sub.ipynb" });
    const text = call.content[0]!.text;
    expect(text).toContain("read the notebook with Read instead");
    expect(text).not.toContain("Proceed without it.");
    expect(call.details?.degraded).toBe(true);
  });
});

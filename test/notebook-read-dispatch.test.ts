import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
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

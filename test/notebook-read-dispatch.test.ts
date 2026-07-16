import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import picc from "../src/index.js";
import { fakePi, type FakePi } from "./helpers/fake-pi.js";
import { fakeSdk, type FakeCustomTool, type FakeSdkHandle } from "./helpers/fake-sdk.js";
import { cleanupFixture, materializeFixture } from "./helpers/fixture.js";

/**
 * F18 — the `allKnownToolNames` wiring for the real NotebookRead tool, proven
 * through the REAL `picc(...)` dispatch path with a fake Pi SDK (no LLM/network).
 *
 * `gateTools` filters an agent's grant against `allKnownToolNames()`; if the
 * literal "NotebookRead" is absent there, the name is treated as unknown and
 * silently dropped, so a NotebookRead customTool would never reach a dispatched
 * subagent even though future-agent inherits ALL tools. This test dispatches
 * future-agent and asserts a NotebookRead customTool actually reached the
 * created subagent session — it fails iff the literal is missing (the compat-
 * report tests route through the registry, not gateTools, so they cannot catch
 * this). Mirrors test/slashcommand-fork.test.ts:79-109.
 */

let dir: string;
let pi: FakePi;
let h: FakeSdkHandle;
const originalCwd = process.cwd();

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
  cleanupFixture(dir);
});

describe("NotebookRead subagent-dispatch wiring (F18)", () => {
  it("provisions the main session with a real NotebookRead tool", () => {
    expect(pi.tools.has("NotebookRead")).toBe(true);
  });

  it("grants a real NotebookRead tool to a subagent that inherits all tools", async () => {
    const agentTool = pi.tools.get("Agent");
    // future-agent has no `tools:` frontmatter → inherits ALL tools → is granted
    // NotebookRead. This exercises the allKnownToolNames MUST-FIX + the subagent
    // grant block: without the "NotebookRead" literal, gateTools drops the name
    // and the subagent could never receive the tool. Pin foreground so the
    // subagent session is created synchronously and its customTools inspectable.
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
  });
});

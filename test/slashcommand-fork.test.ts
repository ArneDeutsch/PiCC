import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import picc from "../src/index.js";
import { SubagentRegistry } from "../src/runtime/subagent-registry.js";
import { fakePi, type FakePi } from "./helpers/fake-pi.js";
import {
  fakeSdk,
  type FakeCustomTool,
  type FakeSdkHandle,
  type FakeSessionState,
} from "./helpers/fake-sdk.js";
import { cleanupFixture, materializeFixture } from "./helpers/fixture.js";

/**
 * F11 — the SlashCommand tool's dispatch-bound behaviors that the offline
 * integration layer cannot reach (its subagentRuntime would load the real SDK):
 * a `context: fork` skill invoked through SlashCommand forks and returns the
 * forked result, and a subagent GRANTED SlashCommand gets a working instance
 * carrying its dispatch depth. Driven through the REAL `picc(...)` wiring with a
 * fake Pi SDK injected via the (in-process-only) test seam — no LLM/network,
 * process-free, OS-agnostic. NOT an e2e test.
 */

let dir: string;
let pi: FakePi;
let h: FakeSdkHandle;
let registry: SubagentRegistry | undefined;
// Set true the first time a dispatched subagent that HAS a SlashCommand grant is
// prompted, so it invokes its own SlashCommand exactly once (a `context: fork`
// skill), proving the granted instance works and carries the subagent's depth.
let subagentInvokedSlash = false;
const originalCwd = process.cwd();

beforeAll(async () => {
  dir = materializeFixture("full-surface");
  const userDir = path.join(dir, ".claude-user");
  fs.mkdirSync(userDir, { recursive: true });
  process.env.PICC_CLAUDE_USER_DIR = userDir;
  process.chdir(dir);

  h = fakeSdk({
    onPrompt: async (_text: string, session: FakeSessionState) => {
      const slash = session.customTools.find((t: FakeCustomTool) => t.name === "SlashCommand");
      if (slash && !subagentInvokedSlash) {
        subagentInvokedSlash = true;
        // The granted-subagent instance runs a context:fork skill; the resulting
        // nested dispatch registers one depth deeper than this subagent.
        await slash.execute("nested", { command: "/fork-research nested topic" });
      }
      return "FORK-CANARY-REPLY";
    },
  });

  pi = fakePi();
  picc(pi.api as never, {
    sdk: h.sdk,
    onWired: ({ subagentRegistry }) => {
      registry = subagentRegistry;
    },
  });
  await new Promise((r) => setTimeout(r, 500));
});

afterAll(() => {
  process.chdir(originalCwd);
  cleanupFixture(dir);
});

describe("SlashCommand context:fork dispatch (F11)", () => {
  it("forks a context:fork skill and returns the forked final message", async () => {
    const slash = pi.tools.get("SlashCommand");
    const res = await slash.execute("f1", { command: "/fork-research the WASM ABI" });
    expect(res.details.forked).toBe(true);
    expect(res.details.agent).toBe("researcher");
    expect(res.content[0].text).toBe("FORK-CANARY-REPLY");
  });

  it("grants a working instance to a subagent that carries its dispatch depth", async () => {
    const agentTool = pi.tools.get("Agent");
    // future-agent inherits ALL tools (no `tools:` frontmatter) → it is granted
    // SlashCommand. This exercises the allKnownToolNames MUST-FIX + the subagent
    // grant block: without either, the subagent could never receive the tool.
    const res = await agentTool.execute("a1", { subagent_type: "future-agent", prompt: "go" });
    expect(res.details.outcome).toBe("completed");

    // The subagent's session was created with a working SlashCommand customTool.
    const granted = h.created.find((opts) =>
      ((opts.customTools as FakeCustomTool[]) ?? []).some((t) => t.name === "SlashCommand"),
    );
    expect(granted, "a dispatched subagent got a SlashCommand customTool").toBeDefined();

    // Depth propagation: the subagent registered at depth 1 (main Agent → depth+1),
    // and the fork it launched through its OWN SlashCommand registered one deeper
    // (depth 2) — proving the granted instance carried the subagent's depth into
    // the fork, so nested-subagent limits still apply.
    const records = registry?.list() ?? [];
    const future = records.find((r) => r.agentName === "future-agent");
    expect(future?.depth).toBe(1);
    const nestedFork = records.find((r) => r.agentName === "researcher" && r.depth === 2);
    expect(nestedFork, "the subagent's SlashCommand fork registered at depth 2").toBeDefined();
  });
});

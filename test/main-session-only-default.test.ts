import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import picc from "../src/index.js";
import { SubagentRegistry } from "../src/runtime/subagent-registry.js";
import { fakePi, type FakePi } from "./helpers/fake-pi.js";
import {
  fakeSdk,
  makeAgent,
  makeSubagentRuntime,
  type FakeCustomTool,
  type FakeSdkHandle,
  type FakeSessionState,
} from "./helpers/fake-sdk.js";

/**
 * F22 t01 — main-session-only by DEFAULT. With no subagent settings configured,
 * `createDefaultSettings()` resolves `subagentMaxDepth` to 1, so:
 *   - the main session (depth 0) is untouched: it keeps Agent + Task and the
 *     "Available subagents" catalog (gated only on subagentsEnabled), and
 *   - a dispatched depth-1 subagent — even one that INHERITS ALL TOOLS — gets
 *     neither Agent nor Task and its prompt omits the catalog (the depth gate,
 *     `depth+1 <= maxDepth`, is false at 2 <= 1), and
 *   - any depth-2 dispatch is refused by the runtime guard, including the
 *     non-Agent `context: fork` alternate path.
 *
 * Driven through the REAL `picc(...)` wiring with a fake Pi SDK injected via the
 * in-process test seam — no LLM/network, process-free, OS-agnostic. The enforcement
 * itself is unchanged in this task; only the default constant flipped.
 *
 * NON-VACUOUSNESS: every absence assertion dispatches a subagent that inherits all
 * tools (no `tools:` frontmatter), so the ONLY reason Agent/Task/catalog is absent
 * is the depth cap — never a missing grant. Each absence is paired with a positive
 * control (the main session, a granted-but-non-dispatch tool, or a depth-1 record).
 */

/** Windows-safe temp-dir cleanup: never fail a suite over a transiently locked cwd. */
function rmQuiet(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    // Windows: the just-vacated cwd can stay locked (scanners) — leave it to OS tmp cleanup.
  }
}

// ---------------------------------------------------------------------------
// Unit: the runtime depth guard is driven purely by maxDepth.
// ---------------------------------------------------------------------------
describe("F22: runtime depth guard under maxDepth 1 (and the opt-in mirror)", () => {
  it("rejects a direct depth-2 dispatch at maxDepth 1", async () => {
    const { sdk } = fakeSdk({ replies: ["x"] });
    const runtime = makeSubagentRuntime([makeAgent()], sdk, { maxDepth: 1 });
    const result = await runtime.dispatch({ subagentType: "reviewer", prompt: "p", depth: 2 });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("depth");
  });

  it("POSITIVE MIRROR: explicit maxDepth 2 admits depth 2 (opt-in restores one generation)", async () => {
    const { sdk } = fakeSdk({ replies: ["x"] });
    const runtime = makeSubagentRuntime([makeAgent()], sdk, { maxDepth: 2 });
    const result = await runtime.dispatch({ subagentType: "reviewer", prompt: "p", depth: 2 });
    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Offline-integration: default settings ⇒ maxDepth 1 through the real picc() wiring.
// ---------------------------------------------------------------------------
describe("F22: default settings keep the main session but stop depth-1 subagents recursing", () => {
  let dir: string;
  let pi: FakePi;
  let h: FakeSdkHandle;
  const originalCwd = process.cwd();
  const savedUserDir = process.env.PICC_CLAUDE_USER_DIR;

  beforeAll(async () => {
    // Bare default project: NO settings.json ⇒ createDefaultSettings ⇒ maxDepth 1.
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "picc-mso-"));
    fs.writeFileSync(path.join(dir, "CLAUDE.md"), "MSO-ROOT-CLAUDE-MD\n");
    const userDir = path.join(dir, ".claude-user");
    fs.mkdirSync(userDir, { recursive: true });
    process.env.PICC_CLAUDE_USER_DIR = userDir;
    process.chdir(dir);

    h = fakeSdk({ replies: ["subagent-done"] });
    pi = fakePi();
    picc(pi.api as never, { sdk: h.sdk });
    await new Promise((r) => setTimeout(r, 200));
  });

  afterAll(() => {
    process.chdir(originalCwd);
    if (savedUserDir === undefined) delete process.env.PICC_CLAUDE_USER_DIR;
    else process.env.PICC_CLAUDE_USER_DIR = savedUserDir;
    rmQuiet(dir);
  });

  it("POSITIVE CONTROL: the main session (depth 0) still exposes Agent + Task and the subagents catalog", async () => {
    expect(pi.tools.has("Agent")).toBe(true);
    expect(pi.tools.has("Task")).toBe(true);
    const prompt = (await pi.fire("before_agent_start", { systemPrompt: "B" })).systemPrompt as string;
    expect(prompt).toContain("Available subagents");
    expect(prompt).toContain("- general-purpose:");
  });

  it("a depth-1 subagent that inherits ALL tools gets neither Agent nor Task and no catalog", async () => {
    const agentTool = pi.tools.get("Agent");
    // general-purpose inherits every tool (no `tools:` restriction) — so the ONLY
    // reason Agent/Task/catalog is absent below is the depth cap, not a missing grant.
    // Pin foreground so the subagent session is created synchronously before execute() returns.
    const res = await agentTool.execute("t", {
      subagent_type: "general-purpose",
      prompt: "do the work inline",
      run_in_background: false,
    });
    expect(res.details.outcome).toBe("completed");

    const created = h.created[h.created.length - 1]!;
    const toolNames = ((created.customTools as FakeCustomTool[]) ?? []).map((t) => t.name);
    // NON-VACUOUSNESS: the subagent DID get its inherited non-dispatch tools
    // (provisioning ran, inheritance is broad) — it is specifically the nested
    // dispatch tools that the depth gate withholds.
    expect(toolNames).toContain("SlashCommand");
    expect(toolNames).not.toContain("Agent");
    expect(toolNames).not.toContain("Task");

    // The subagent's own system prompt omits the catalog (it would only produce
    // unknown-tool calls without the nested Agent tool).
    const loader = created.resourceLoader as { options: { systemPromptOverride: () => string } };
    const subPrompt = loader.options.systemPromptOverride();
    expect(subPrompt).not.toContain("Available subagents");
  });
});

// ---------------------------------------------------------------------------
// Offline-integration: the non-Agent `context: fork` alternate path is refused too.
// ---------------------------------------------------------------------------
describe("F22: a subagent-invoked context:fork (depth 2) is refused under the default", () => {
  let dir: string;
  let pi: FakePi;
  let h: FakeSdkHandle;
  let registry: SubagentRegistry | undefined;
  let forkError: string | undefined;
  let invokedSlash = false;
  const originalCwd = process.cwd();
  const savedUserDir = process.env.PICC_CLAUDE_USER_DIR;

  beforeAll(async () => {
    // Purpose-built DEFAULT-settings project (no `subagents` block ⇒ maxDepth 1)
    // that STILL ships a `context: fork` skill and a subagent inheriting SlashCommand.
    // The bare builtin-agents fixture has no skills; full-surface pins maxDepth 2 —
    // neither fits, so build the exact combination inline.
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "picc-mso-fork-"));
    const w = (rel: string, content: string) => {
      const file = path.join(dir, rel);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content);
    };
    w("CLAUDE.md", "MSO-FORK-CLAUDE-MD\n");
    // A subagent inheriting ALL tools (no `tools:` restriction ⇒ granted SlashCommand).
    w(
      ".claude/agents/slash-agent.md",
      ["---", "description: inherits all tools incl. SlashCommand", "---", "Body"].join("\n"),
    );
    // The fork target agent.
    w(
      ".claude/agents/researcher.md",
      ["---", "description: researcher", "tools: Read", "---", "You are the researcher."].join("\n"),
    );
    // A context:fork skill the subagent will invoke via SlashCommand (would be depth 2).
    w(
      ".claude/skills/fork-x/SKILL.md",
      [
        "---",
        "name: fork-x",
        "description: research in a forked context",
        "context: fork",
        "agent: researcher",
        'argument-hint: "<topic>"',
        "---",
        "Research: $ARGUMENTS",
      ].join("\n"),
    );
    const userDir = path.join(dir, ".claude-user");
    fs.mkdirSync(userDir, { recursive: true });
    process.env.PICC_CLAUDE_USER_DIR = userDir;
    process.chdir(dir);

    h = fakeSdk({
      onPrompt: async (_text: string, session: FakeSessionState) => {
        const slash = session.customTools.find((t: FakeCustomTool) => t.name === "SlashCommand");
        if (slash && !invokedSlash) {
          invokedSlash = true;
          // The granted-subagent instance carries depth 1; a context:fork dispatch
          // from it targets depth 2, which the guard refuses at maxDepth 1. A real
          // model would just get a tool error and continue — capture it and reply.
          try {
            await slash.execute("nested", { command: "/fork-x nested topic" });
          } catch (err) {
            forkError = (err as Error).message;
          }
        }
        return "SUBAGENT-REPLY";
      },
    });

    pi = fakePi();
    picc(pi.api as never, {
      sdk: h.sdk,
      onWired: ({ subagentRegistry }) => {
        registry = subagentRegistry;
      },
    });
    await new Promise((r) => setTimeout(r, 300));
  });

  afterAll(() => {
    process.chdir(originalCwd);
    if (savedUserDir === undefined) delete process.env.PICC_CLAUDE_USER_DIR;
    else process.env.PICC_CLAUDE_USER_DIR = savedUserDir;
    rmQuiet(dir);
  });

  it("no depth-2 record registers, and the depth-1 record DOES (positive control)", async () => {
    const agentTool = pi.tools.get("Agent");
    const res = await agentTool.execute("a1", {
      subagent_type: "slash-agent",
      prompt: "go",
      run_in_background: false,
    });
    // The subagent itself completes (its refused tool call did not crash the run).
    expect(res.details.outcome).toBe("completed");
    expect(invokedSlash).toBe(true);

    // The alternate path was refused by the runtime guard, naming the depth cap.
    expect(forkError).toBeDefined();
    expect(forkError).toContain("exceeds the configured maximum");

    const records = registry?.list() ?? [];
    // POSITIVE CONTROL: the depth-1 dispatch really ran and registered — so the
    // missing depth-2 record is a refusal, not a dispatch that never happened.
    const depth1 = records.find((r) => r.agentName === "slash-agent" && r.depth === 1);
    expect(depth1, "the depth-1 subagent registered").toBeDefined();
    // The context:fork dispatch at depth 2 is refused BEFORE registration.
    expect(records.find((r) => r.depth === 2)).toBeUndefined();
  });
});

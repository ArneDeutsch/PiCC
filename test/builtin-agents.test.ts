import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Built-in agents wired through the WHOLE extension (audits E1/E2/E6 + B5):
 * Agent/Task registration without project agents, catalog listing, the
 * Explore/Plan CLAUDE.md-skipping prompt, and agent `memory:` injection.
 *
 * The Pi SDK is partially mocked: subagent dispatches get a fake session and a
 * capturing resource loader, everything else stays real.
 */

const h = vi.hoisted(() => ({
  created: [] as Array<Record<string, unknown>>,
}));

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
  const real = await importOriginal<Record<string, unknown>>();
  // Shared fake-SDK builder (t01): the session/loader fakes live in one place.
  const { fakeSdk } = await import("./helpers/fake-sdk.js");
  const { sdk } = fakeSdk({ replies: ["bi-done"], created: h.created });
  return {
    ...real,
    createAgentSession: (options: Record<string, unknown>) => sdk.createAgentSession(options),
    DefaultResourceLoader: sdk.DefaultResourceLoader,
    SessionManager: { inMemory: () => ({}) },
    SettingsManager: { inMemory: () => ({}) },
    getAgentDir: () => "/fake-agent-dir",
  };
});

import picc from "../src/index.js";
import { MEMORY_WRITE_POLICY } from "../src/runtime/context-assembly.js";
import { fakePi, type FakePi } from "./helpers/fake-pi.js";

let dir: string;
let pi: FakePi;
const originalCwd = process.cwd();
const savedUserDir = process.env.PICC_CLAUDE_USER_DIR;

/** Dispatch through the registered Agent tool and return the captured loader's system prompt. */
async function dispatchAndGetPrompt(subagentType: string): Promise<string> {
  const agentTool = pi.tools.get("Agent");
  // F15: background is the default, but this helper inspects the subagent session
  // created synchronously during dispatch — pin run_in_background: false so the
  // dispatch runs foreground and h.created is populated before execute() returns.
  await agentTool.execute("t", {
    subagent_type: subagentType,
    prompt: "task",
    run_in_background: false,
  });
  const options = h.created[h.created.length - 1]!;
  const loader = options.resourceLoader as { options: Record<string, unknown> };
  return (loader.options.systemPromptOverride as () => string)();
}

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "picc-bi-"));
  const w = (rel: string, content: string) => {
    const file = path.join(dir, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  };
  w("CLAUDE.md", "BI-ROOT-CLAUDE-MD\n");
  w(".claude/rules/uncond.md", "BI-UNCOND-RULE\n");
  // A project agent overriding the built-in Explore.
  w(
    ".claude/agents/Explore.md",
    ["---", "description: project explorer", "---", "PROJECT-EXPLORE-BODY"].join("\n"),
  );
  // Agents exercising each memory: scope (audit B5).
  w(
    ".claude/agents/mem-project.md",
    ["---", "description: project memory agent", "memory: project", "---", "Body"].join("\n"),
  );
  w(
    ".claude/agents/mem-user.md",
    ["---", "description: user memory agent", "memory: user", "---", "Body"].join("\n"),
  );
  w(
    ".claude/agents/mem-local.md",
    ["---", "description: local memory agent", "memory: local", "---", "Body"].join("\n"),
  );
  w(
    ".claude/agents/mem-weird.md",
    ["---", "description: unknown memory scope", "memory: banana", "---", "Body"].join("\n"),
  );
  w(".claude/agent-memory/mem-project/MEMORY.md", "BI-MEM-PROJECT-CONTENT\n");
  w(".claude/agent-memory-local/mem-local/MEMORY.md", "BI-MEM-LOCAL-CONTENT\n");
  // Project auto memory (H2): pinned to a deterministic dir via settings.
  w(path.join("auto-memory", "MEMORY.md"), "BI-AUTO-MEMORY-CONTENT\n");
  w(
    ".claude/settings.json",
    JSON.stringify({ autoMemoryDirectory: path.join(dir, "auto-memory") }),
  );

  const userDir = path.join(dir, ".claude-user");
  fs.mkdirSync(path.join(userDir, "agent-memory", "mem-user"), { recursive: true });
  fs.writeFileSync(path.join(userDir, "agent-memory", "mem-user", "MEMORY.md"), "BI-MEM-USER-CONTENT\n");
  process.env.PICC_CLAUDE_USER_DIR = userDir;
  process.chdir(dir);
  pi = fakePi();
  picc(pi.api as never);
  await new Promise((r) => setTimeout(r, 200));
});

afterAll(() => {
  process.chdir(originalCwd);
  if (savedUserDir === undefined) delete process.env.PICC_CLAUDE_USER_DIR;
  else process.env.PICC_CLAUDE_USER_DIR = savedUserDir;
  // Windows: the just-vacated cwd can stay locked beyond any reasonable retry
  // (external scanners) — same phenomenon as the inner `bare` dir below. Never
  // fail the whole file over temp-dir cleanup; leave stragglers to OS tmp cleanup.
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    // Transiently locked — intentionally ignored.
  }
});

describe("built-in agents through the extension (E1/E2/E6)", () => {
  it("registers Agent/Task and the real TaskOutput/TaskStop even when a project has NO agents", async () => {
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), "picc-bi-bare-"));
    try {
      fs.writeFileSync(path.join(bare, "CLAUDE.md"), "bare\n");
      process.chdir(bare);
      const pi2 = fakePi();
      picc(pi2.api as never);
      for (const name of ["Agent", "Task", "TaskOutput", "TaskStop"]) {
        expect(pi2.tools.has(name), `missing tool ${name}`).toBe(true);
      }
      // The catalog advertises the built-ins.
      const prompt = (await pi2.fire("before_agent_start", { systemPrompt: "B" }))
        .systemPrompt as string;
      expect(prompt).toContain("Available subagents");
      expect(prompt).toContain("- general-purpose:");
      expect(prompt).toContain("- Explore:");
      expect(prompt).toContain("- Plan:");
    } finally {
      process.chdir(dir);
      try {
        fs.rmSync(bare, { recursive: true, force: true });
      } catch {
        // Windows: the just-vacated cwd can be transiently locked — leave it to tmp cleanup.
      }
    }
  });

  it("lists built-ins after project agents; an overridden built-in appears once (the project's)", async () => {
    const prompt = (await pi.fire("before_agent_start", { systemPrompt: "B" }))
      .systemPrompt as string;
    expect(prompt).toContain("- general-purpose:");
    expect(prompt).toContain("- Plan:");
    // The project's Explore wins; the built-in Explore description is gone.
    expect(prompt).toContain("- Explore: project explorer");
    expect(prompt).not.toContain("Fast read-only agent");
  });

  it("Plan (built-in) prompt omits CLAUDE.md and rules but keeps harness conventions and skills (E6)", async () => {
    const prompt = await dispatchAndGetPrompt("Plan");
    expect(prompt).not.toContain("BI-ROOT-CLAUDE-MD");
    expect(prompt).not.toContain("BI-UNCOND-RULE");
    expect(prompt).toContain("Claude Code compatibility conventions");
    expect(prompt).toContain("You are a software architect");
  });

  it("general-purpose prompt DOES include CLAUDE.md and rules", async () => {
    const prompt = await dispatchAndGetPrompt("general-purpose");
    expect(prompt).toContain("BI-ROOT-CLAUDE-MD");
    expect(prompt).toContain("BI-UNCOND-RULE");
  });

  it("a project agent overriding Explore keeps the full project context (no built-in skipping)", async () => {
    const prompt = await dispatchAndGetPrompt("Explore");
    expect(prompt).toContain("PROJECT-EXPLORE-BODY");
    expect(prompt).toContain("BI-ROOT-CLAUDE-MD");
  });

  it("omitted subagent_type dispatches general-purpose (E2)", async () => {
    const agentTool = pi.tools.get("Agent");
    // F15: pin run_in_background: false so the foreground verbatim result + agent
    // detail are asserted directly (background is the default otherwise).
    const res = await agentTool.execute("t", { prompt: "just do it", run_in_background: false });
    expect(res.content[0].text).toBe("bi-done");
    expect(res.details.agent).toBe("general-purpose");
  });

  it("TaskOutput errors helpfully on unknown ids at the extension level", async () => {
    await expect(pi.tools.get("TaskOutput").execute("t", { task_id: "task-9" })).rejects.toThrow(
      /Unknown task_id/,
    );
  });
});

describe("agent memory injection (audit B5)", () => {
  it.each([
    ["mem-project", path.join(".claude", "agent-memory", "mem-project"), "BI-MEM-PROJECT-CONTENT"],
    ["mem-user", path.join(".claude-user", "agent-memory", "mem-user"), "BI-MEM-USER-CONTENT"],
    ["mem-local", path.join(".claude", "agent-memory-local", "mem-local"), "BI-MEM-LOCAL-CONTENT"],
  ])("injects the %s scope memory dir and MEMORY.md content", async (agentName, relDir, marker) => {
    const prompt = await dispatchAndGetPrompt(agentName);
    expect(prompt).toContain("# Agent memory");
    expect(prompt).toContain(path.join(dir, relDir));
    expect(prompt).toContain(marker);
    // The per-agent guidance is now conservative (F10). Assert on a phrase UNIQUE to
    // the OLD per-agent string — the co-injected "# Auto memory" section would satisfy
    // a whole-prompt /remember/i even if the per-agent string had not been flipped, so
    // that is a false green. "You may persist" only ever appeared in the per-agent
    // string, so its absence proves the per-agent flip specifically.
    expect(prompt).not.toContain("You may persist");
    // ...and positively pin that the conservative policy actually reached the per-agent
    // section: these agents also get the co-injected "# Auto memory" section, so the shared
    // MEMORY_WRITE_POLICY must appear exactly twice. A dropped per-agent push collapses it
    // to 1 (no write guidance at that site) and fails — closing the "removal-only" gap.
    expect(prompt.split(MEMORY_WRITE_POLICY).length - 1).toBe(2);
  });

  it("unknown memory scope injects NO memory section (visible degrade)", async () => {
    const prompt = await dispatchAndGetPrompt("mem-weird");
    expect(prompt).not.toContain("# Agent memory");
  });

  it("built-ins have no memory section either", async () => {
    const prompt = await dispatchAndGetPrompt("general-purpose");
    expect(prompt).not.toContain("# Agent memory");
  });
});

describe("auto memory in subagent prompts (H2)", () => {
  it("general-purpose gets the project's auto memory", async () => {
    const prompt = await dispatchAndGetPrompt("general-purpose");
    expect(prompt).toContain("# Auto memory");
    expect(prompt).toContain("BI-AUTO-MEMORY-CONTENT");
  });

  it("custom project agents get it too", async () => {
    const prompt = await dispatchAndGetPrompt("mem-weird");
    expect(prompt).toContain("# Auto memory");
    expect(prompt).toContain("BI-AUTO-MEMORY-CONTENT");
  });

  it("skipProjectContext built-ins (Plan) omit it", async () => {
    const prompt = await dispatchAndGetPrompt("Plan");
    expect(prompt).not.toContain("# Auto memory");
    expect(prompt).not.toContain("BI-AUTO-MEMORY-CONTENT");
  });
});

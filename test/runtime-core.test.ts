import { describe, expect, it } from "vitest";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { CwdState } from "../src/runtime/cwd-state.js";
import {
  applyUpdatedInput,
  claudeToolsToPiBuiltins,
  toClaudeCall,
  toClaudeToolName,
  touchedFilePath,
} from "../src/runtime/tool-map.js";
import {
  buildSystemPromptSuffix,
  contextForTouchedFile,
  newSessionContextState,
} from "../src/runtime/context-assembly.js";
import { mapEffort, steeringForModel, type PiClauDexConfig } from "../src/runtime/steering.js";
import { SubagentRuntime, createAgentToolDefinition, extractText, type PiSdk } from "../src/runtime/subagents.js";
import { PermissionEngine } from "../src/engine/permissions.js";
import { HookRunner } from "../src/engine/hook-runner.js";
import type { ClaudeAgent, ClaudeSettings } from "../src/types.js";

function baseSettings(): ClaudeSettings {
  return {
    permissions: { allow: [], deny: [], ask: [], additionalDirectories: [] },
    hooks: {},
    env: {},
    disableAllHooks: false,
    disableSkillShellExecution: false,
    skillOverrides: {},
    claudeMdExcludes: [],
    worktree: { baseRef: "head" },
    subagentsEnabled: true,
    subagentMaxDepth: 2,
    subagentConcurrency: 4,
    enabledPlugins: undefined,
    unknownKeys: [],
    deferredKeys: [],
    diagnostics: [],
  };
}

function makeAgent(overrides: Partial<ClaudeAgent> = {}): ClaudeAgent {
  return {
    name: "reviewer",
    description: "Reviews things",
    metadata: {},
    body: "You are the reviewer.",
    source: { path: "<test>", scope: "project" },
    unknownKeys: [],
    diagnostics: [],
    ...overrides,
  };
}

describe("CwdState", () => {
  it("swaps and restores the effective cwd", () => {
    const s = new CwdState("C:\\base");
    expect(s.get()).toBe("C:\\base");
    s.enterWorktree("C:\\base\\.claude\\worktrees\\x");
    expect(s.get()).toBe("C:\\base\\.claude\\worktrees\\x");
    expect(s.getWorktree()).toBe("C:\\base\\.claude\\worktrees\\x");
    s.exitWorktree();
    expect(s.get()).toBe("C:\\base");
    expect(s.getWorktree()).toBeUndefined();
  });
});

describe("tool-map", () => {
  it("maps pi built-ins to Claude names and passes unknown names through", () => {
    expect(toClaudeToolName("read")).toBe("Read");
    expect(toClaudeToolName("find")).toBe("Glob");
    expect(toClaudeToolName("WebFetch")).toBe("WebFetch");
  });

  it("grants pi builtins from Claude tool lists", () => {
    expect(claudeToolsToPiBuiltins(["Read", "Grep"]).sort()).toEqual(["grep", "read"]);
    expect(claudeToolsToPiBuiltins(["Glob"]).sort()).toEqual(["find", "ls"]);
    expect(claudeToolsToPiBuiltins(["*"])).toContain("bash");
    expect(claudeToolsToPiBuiltins(["WebFetch"])).toEqual([]);
  });

  it("translates path to file_path for matching and back for updatedInput", () => {
    const call = toClaudeCall("read", { path: "src/a.ts" }, "C:\\proj");
    expect(call.tool).toBe("Read");
    expect(call.input.file_path).toBe("src/a.ts");

    const live: Record<string, unknown> = { path: "src/a.ts" };
    applyUpdatedInput("read", live, { file_path: "src/b.ts" });
    expect(live.path).toBe("src/b.ts");

    const custom: Record<string, unknown> = { url: "https://x" };
    applyUpdatedInput("WebFetch", custom, { url: "https://y" });
    expect(custom.url).toBe("https://y");
  });

  it("reports touched files only for file tools", () => {
    expect(touchedFilePath("read", { path: "a.ts" })).toBe("a.ts");
    expect(touchedFilePath("edit", { file_path: "b.ts" })).toBe("b.ts");
    expect(touchedFilePath("bash", { command: "cat a.ts" })).toBeUndefined();
  });
});

describe("steering", () => {
  const config: PiClauDexConfig = {
    steering: { "openai/*": "Be terse.", "*/gpt-5*": "Use locked YAML faithfully." },
    effortMap: { low: "low", medium: "medium", high: "high", max: "max", maximum: "max" },
    diagnostics: [],
  };

  it("concatenates all matching steering patterns", () => {
    expect(steeringForModel(config, "openai/gpt-5.5")).toBe("Be terse.\n\nUse locked YAML faithfully.");
    expect(steeringForModel(config, "anthropic/claude-x")).toBeUndefined();
  });

  it("maps effort values and prose", () => {
    expect(mapEffort(config, "high")).toBe("high");
    expect(mapEffort(config, "apply MAXIMUM reasoning effort")).toBe("max");
    expect(mapEffort(config, undefined)).toBeUndefined();
    expect(mapEffort(config, "unmappable-nonsense")).toBeUndefined();
  });
});

describe("context assembly", () => {
  const claudeMd = [
    {
      path: "C:\\proj\\CLAUDE.md",
      dir: "C:\\proj",
      content: "ROOT-INSTRUCTIONS",
      scope: "project" as const,
      loadAtStart: true,
      diagnostics: [],
    },
  ];

  it("builds a suffix containing instructions, rules, skills, agents and steering", () => {
    const suffix = buildSystemPromptSuffix({
      claudeMd,
      rules: [
        { id: "a.md", body: "UNCOND-RULE", source: { path: "x", scope: "project" }, unknownKeys: [], diagnostics: [] },
        { id: "b.md", paths: ["src/**"], body: "PATH-RULE", source: { path: "y", scope: "project" }, unknownKeys: [], diagnostics: [] },
      ],
      skills: [
        {
          name: "sk",
          description: "does things",
          userInvocable: true,
          disableModelInvocation: false,
          contextFork: false,
          shell: "bash" as const,
          metadata: {},
          baseDir: "d",
          source: { path: "p", scope: "project" as const },
          legacyCommand: false,
          unknownKeys: [],
          diagnostics: [],
        },
      ],
      agents: [makeAgent()],
      settings: baseSettings(),
      state: newSessionContextState(claudeMd),
      steeringText: "STEER-TEXT",
    });
    expect(suffix).toContain("ROOT-INSTRUCTIONS");
    expect(suffix).toContain("UNCOND-RULE");
    expect(suffix).not.toContain("PATH-RULE"); // path-scoped rules only inject on touch
    expect(suffix).toContain("- sk: does things");
    expect(suffix).toContain("reviewer: Reviews things");
    expect(suffix).toContain("STEER-TEXT");
    expect(suffix).toContain("Claude Code compatibility conventions");
  });

  it("keeps activated skill bodies resident", () => {
    const state = newSessionContextState(claudeMd);
    state.activeSkills.set("sk", "ACTIVE-SKILL-BODY");
    const suffix = buildSystemPromptSuffix({
      claudeMd,
      rules: [],
      skills: [],
      agents: [],
      settings: baseSettings(),
      state,
    });
    expect(suffix).toContain("ACTIVE-SKILL-BODY");
  });

  it("injects nested CLAUDE.md and path rules once per session on file touch", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pcd-ctx-"));
    try {
      fs.mkdirSync(path.join(dir, "src"), { recursive: true });
      fs.writeFileSync(path.join(dir, "src", "CLAUDE.md"), "NESTED-SRC");
      fs.writeFileSync(path.join(dir, "src", "a.rs"), "fn main(){}");
      const state = newSessionContextState([]);
      const rules = [
        {
          id: "rust.md",
          paths: ["src/**/*.rs"],
          body: "RUST-RULE",
          source: { path: "r", scope: "project" as const },
          unknownKeys: [],
          diagnostics: [],
        },
      ];
      const first = contextForTouchedFile({
        filePath: path.join(dir, "src", "a.rs"),
        cwd: dir,
        projectRoot: dir,
        rules,
        settings: baseSettings(),
        state,
      });
      expect(first).toContain("NESTED-SRC");
      expect(first).toContain("RUST-RULE");
      const second = contextForTouchedFile({
        filePath: path.join(dir, "src", "a.rs"),
        cwd: dir,
        projectRoot: dir,
        rules,
        settings: baseSettings(),
        state,
      });
      expect(second).toBeUndefined();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("SubagentRuntime (fake SDK)", () => {
  function fakeSdk(replies: string[]): { sdk: PiSdk; created: Array<Record<string, unknown>> } {
    const created: Array<Record<string, unknown>> = [];
    let i = 0;
    const sdk: PiSdk = {
      async createAgentSession(options) {
        created.push(options);
        const messages: Array<{ role: string; content: unknown }> = [];
        return {
          session: {
            async prompt(text: string) {
              messages.push({ role: "user", content: text });
              const reply = replies[Math.min(i, replies.length - 1)];
              i++;
              messages.push({ role: "assistant", content: [{ type: "text", text: reply }] });
            },
            messages,
            dispose() {},
          },
        };
      },
      DefaultResourceLoader: class {
        constructor(public options: Record<string, unknown>) {}
        async reload() {}
      },
      inMemorySessionManager: () => ({}),
      inMemorySettingsManager: () => ({}),
      agentDir: () => "/fake/agent-dir",
    };
    return { sdk, created };
  }

  function makeRuntime(agents: ClaudeAgent[], replies: string[], overrides: Record<string, unknown> = {}) {
    const { sdk, created } = fakeSdk(replies);
    const engine = new PermissionEngine(
      { allow: [], deny: [], ask: [], additionalDirectories: [] },
      { cwd: process.cwd() },
    );
    const hookRunner = new HookRunner({
      config: {},
      projectDir: process.cwd(),
      sessionId: "t",
      env: {},
      disableAllHooks: true,
    });
    const runtime = new SubagentRuntime({
      getAgents: () => agents,
      buildSystemPrompt: (a) => `SYSTEM:${a.name}`,
      customToolsFor: () => [],
      allKnownToolNames: () => ["Read", "Write", "Edit", "Bash", "Grep", "Glob"],
      permissionEngine: engine,
      hookRunner,
      getCwd: () => process.cwd(),
      resolveModel: () => undefined,
      mapEffort: () => undefined,
      maxDepth: 2,
      concurrency: 2,
      sessionId: "t",
      sdk,
      ...overrides,
    } as never);
    return { runtime, created };
  }

  it("returns the final assistant message verbatim", async () => {
    const { runtime } = makeRuntime([makeAgent()], ["```yaml\nverdict: approve\n```"]);
    const result = await runtime.dispatch({ subagentType: "reviewer", prompt: "review", depth: 1 });
    expect(result.ok).toBe(true);
    expect(result.finalMessage).toBe("```yaml\nverdict: approve\n```");
  });

  it("rejects unknown agents with the available list", async () => {
    const { runtime } = makeRuntime([makeAgent()], ["x"]);
    const result = await runtime.dispatch({ subagentType: "nope", prompt: "p", depth: 1 });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("reviewer");
  });

  it("enforces the depth cap", async () => {
    const { runtime } = makeRuntime([makeAgent()], ["x"]);
    const result = await runtime.dispatch({ subagentType: "reviewer", prompt: "p", depth: 3 });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("depth");
  });

  it("gates tools per agent (read-only agent gets no write/edit/bash builtins)", async () => {
    const { runtime, created } = makeRuntime(
      [makeAgent({ tools: ["Read", "Grep", "Glob"] })],
      ["ok"],
    );
    await runtime.dispatch({ subagentType: "reviewer", prompt: "p", depth: 1 });
    const tools = created[0]?.tools as string[];
    expect(tools).toContain("read");
    expect(tools).toContain("grep");
    expect(tools).not.toContain("write");
    expect(tools).not.toContain("edit");
    expect(tools).not.toContain("bash");
  });

  it("retries once on an empty reply", async () => {
    const { runtime } = makeRuntime([makeAgent()], ["", "second answer"]);
    const result = await runtime.dispatch({ subagentType: "reviewer", prompt: "p", depth: 1 });
    expect(result.ok).toBe(true);
    expect(result.finalMessage).toBe("second answer");
    expect(result.diagnostics.some((d) => d.message.includes("retried"))).toBe(true);
  });

  it("runs dispatches in parallel under the concurrency cap", async () => {
    const { runtime } = makeRuntime([makeAgent()], ["a"]);
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        runtime.dispatch({ subagentType: "reviewer", prompt: "p", depth: 1 }),
      ),
    );
    expect(results.every((r) => r.ok)).toBe(true);
  });

  it("case-insensitive agent resolution", async () => {
    const { runtime } = makeRuntime([makeAgent({ name: "Reviewer" })], ["ok"]);
    const result = await runtime.dispatch({ subagentType: "reviewer", prompt: "p", depth: 1 });
    expect(result.ok).toBe(true);
  });

  it("Agent tool definition dispatches at depth+1 and throws on failure", async () => {
    const { runtime } = makeRuntime([makeAgent()], ["fine"]);
    const tool = createAgentToolDefinition(runtime, { depth: 0 }) as {
      execute: (id: string, params: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>;
    };
    const res = await tool.execute("t1", { subagent_type: "reviewer", prompt: "go" });
    expect(res.content[0]?.text).toBe("fine");
    await expect(tool.execute("t2", { subagent_type: "ghost", prompt: "go" })).rejects.toThrow(/Unknown subagent_type/);
  });

  it("extractText joins text blocks only", () => {
    expect(extractText([{ type: "text", text: "a" }, { type: "thinking", thinking: "x" }, { type: "text", text: "b" }])).toBe("ab");
    expect(extractText("plain")).toBe("plain");
  });
});

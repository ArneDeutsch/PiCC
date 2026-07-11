import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import picc from "../src/index.js";
import { resolveGitBashPath } from "../src/engine/shell-inject.js";
import { fakePi, type FakePi } from "./helpers/fake-pi.js";
import { cleanupFixture, materializeFixture } from "./helpers/fixture.js";

/**
 * Integration + NFR tests (plan §14, §15.3, §12.1): the whole extension wired against
 * the full-surface conformance fixture through a fake Pi API. No LLM/network involved —
 * these assert the mechanical-fidelity tier end to end.
 */

let dir: string;
let pi: FakePi;
const originalCwd = process.cwd();

beforeAll(async () => {
  dir = materializeFixture("full-surface");
  // Seedable gitignored files for .worktreeinclude
  fs.writeFileSync(path.join(dir, ".env.local"), "SECRET=1\n");
  fs.mkdirSync(path.join(dir, "config"), { recursive: true });
  fs.writeFileSync(path.join(dir, "config", "app.secret"), "s\n");
  // Hermetic user scope: don't absorb the developer's real ~/.claude.
  const userDir = path.join(dir, ".claude-user");
  fs.mkdirSync(userDir, { recursive: true });
  process.env.PICC_CLAUDE_USER_DIR = userDir;
  process.chdir(dir);
  pi = fakePi();
  picc(pi.api as never);
  // built-in overrides register via an async IIFE — give it a beat
  await new Promise((r) => setTimeout(r, 500));
});

afterAll(() => {
  process.chdir(originalCwd);
  cleanupFixture(dir);
});

describe("tool surface registration", () => {
  it("registers the Claude tool surface", () => {
    for (const name of [
      "Agent",
      "Task",
      "Skill",
      "WebFetch",
      "WebSearch",
      "Grep",
      "Glob",
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

  it("registers the /doctor, /compat, /quota, /skills, /agents control commands", () => {
    for (const name of ["doctor", "compat", "quota", "skills", "agents"]) {
      expect(pi.commands.has(name), `missing command ${name}`).toBe(true);
    }
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
    // THE lazy-load NFR: no skill body may be in context before activation (plan §12.1)
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
    // The skill body becomes the turn, with $1/$2 substituted and the body now loaded.
    expect(result.text).toContain("FS-SKILL-ARGS-BODY");
    expect(result.text).toContain("Deploy to environment **staging** at version **4.5**");
  });

  it("does not expand a Pi built-in slash command", async () => {
    const result = await pi.fire("input", { text: "/model gpt-5", source: "interactive" });
    expect(result.action === "continue" || !String(result.text ?? "").includes("FS-SKILL")).toBe(true);
  });

  it("SessionStart hook stdout reaches the model + compat notice raised", async () => {
    pi.messages.length = 0;
    pi.entries.length = 0;
    await pi.fire("session_start", { reason: "startup" }, pi.ctx());
    const sent = pi.messages.map((m) => String(m.message.content)).join("\n");
    expect(sent).toContain("FS-SESSION-START-HOOK-CONTEXT");
    // compat: fixture declares ask rules, defaultMode, .mcp.json, unknown settings → one notice
    const noticeEntry = pi.entries.find((e) => e.customType === "picc-compat");
    expect(noticeEntry).toBeDefined();
    const notice = String(noticeEntry?.data?.notice ?? "");
    expect(notice).toContain("SAFETY");
    expect(notice.toLowerCase()).toContain("ask");
  });

  it("/doctor renders the registry-generated breakdown", async () => {
    pi.entries.length = 0;
    await pi.commands.get("doctor").handler("", pi.ctx());
    const doctor = pi.entries
      .filter((e) => e.customType === "picc-control")
      .map((e) => String(e.data?.output ?? ""))
      .join("\n");
    expect(doctor).toContain("claude-code-2.1.x");
    expect(doctor.toLowerCase()).toContain("mcp");
  });

  it("compaction: PostCompact re-injects active skills mid-run via steer (NFR §9)", async () => {
    const skillTool = pi.tools.get("Skill");
    await skillTool.execute("t6", { name: "deploy", arguments: "prod 2.0" });
    pi.messages.length = 0;
    await pi.fire("session_compact", { reason: "threshold" });
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

  it("two worktrees can coexist (parallel sessions)", async () => {
    const enter = pi.tools.get("EnterWorktree");
    const a = await enter.execute("w3", { name: "parallel-a" });
    const exit = pi.tools.get("ExitWorktree");
    await exit.execute("w4", { action: "keep" });
    const b = await enter.execute("w5", { name: "parallel-b" });
    await exit.execute("w6", { action: "keep" });
    expect(fs.existsSync(a.details.worktreePath)).toBe(true);
    expect(fs.existsSync(b.details.worktreePath)).toBe(true);
  });
});

describe("degradation floor", () => {
  it("unknown hook event, degraded handler types, future settings keys — nothing crashed at load", () => {
    // The extension registered tools/commands despite FuturisticUnknownEvent,
    // a prompt-type PreCompact handler, futureUnknownSetting, outputStyle, .mcp.json,
    // future-agent with mcpServers/memory, and unknown skill frontmatter.
    expect(pi.tools.size).toBeGreaterThan(15);
    expect(pi.commands.size).toBeGreaterThanOrEqual(3); // doctor, compat, quota
  });

  it("future-agent (memory/mcpServers/unknown keys) is still dispatchable via the catalog", async () => {
    const prompt = (await pi.fire("before_agent_start", { systemPrompt: "B" })).systemPrompt as string;
    expect(prompt).toContain("future-agent:");
  });
});

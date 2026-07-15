import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import picc, { type PiccTestSeam } from "../src/index.js";
import { resolveGitBashPath } from "../src/engine/shell-inject.js";
import { fakePi, type FakePi } from "./helpers/fake-pi.js";
import { fakeSdk, type FakeCustomTool, type FakeSessionState } from "./helpers/fake-sdk.js";
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
      "SlashCommand",
      "WebFetch",
      "WebSearch",
      "Grep",
      "Glob",
      "NotebookRead",
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

  it("background dispatch + TaskOutput path is exercisable (F04): bg agent loads, /bg-research expands", async () => {
    // The async-researcher background agent (background: true) reaches the routing catalog…
    const prompt = (await pi.fire("before_agent_start", { systemPrompt: "B" })).systemPrompt as string;
    expect(prompt).toMatch(/- async-researcher( \(read-only\))?: Researches a question in the background/);
    // …and the /bg-research command that dispatches it in the background and retrieves
    // it via TaskOutput expands into the user turn, carrying its canary.
    const expanded = await pi.fire("input", { text: "/bg-research WASM ABI", source: "interactive" });
    expect(expanded.action).toBe("transform");
    expect(expanded.text).toContain("FS-BG-TASKOUTPUT");
    expect(expanded.text).toContain("run_in_background");
    expect(expanded.text).toContain("TaskOutput");
    expect(expanded.text).toContain("WASM ABI"); // $ARGUMENTS substituted
  });
});

describe("SlashCommand tool (F11)", () => {
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
    // The skill body becomes the turn, with $0/$1 substituted and the body now loaded.
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

describe("background settlement notices without polling (t05, offline-integration via the seam)", () => {
  // The fake-Pi harness cannot reach the closure-local registries, so a fresh
  // extension instance is wired with the test-only `onWired` seam (reachable
  // ONLY via this in-process argument — never env/settings/files). Each test
  // seeds a settled background task exactly as a real dispatch would (register →
  // start → settle → markSettled) and then drives the REAL before_agent_start
  // drain handler, asserting the notice reaches the model without any TaskOutput
  // call. Reuses the fixture cwd from the outer beforeAll.
  type Internals = Parameters<NonNullable<PiccTestSeam["onWired"]>>[0];

  function wire(): { p: FakePi; internals: Internals } {
    const p = fakePi();
    let internals!: Internals;
    picc(p.api as never, { onWired: (i) => (internals = i) });
    return { p, internals };
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

  it("announces a settled background task at the next turn (outcome, agent id, framed output) — no TaskOutput needed", async () => {
    const { p, internals } = wire();
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

  it("a pi.sendMessage throw on one notice still delivers the others and re-fires the throwing one next turn (FIX 1)", async () => {
    // The real delivery path (deliverSettlementNotices): each notice is delivered
    // in its own try/catch and the dedup gate is committed ONLY after a successful
    // send. A throw on one notice must neither drop the others nor consume the
    // thrower — it re-fires next turn. Nothing is silently lost.
    const { p, internals } = wire();
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

  it("/usage aggregates per-subagent usage, transcript paths, outcome, and a session total (t06)", async () => {
    const { p, internals } = wire();
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
    const { p } = wire();
    expect(p.commands.has("usage")).toBe(true);
    p.entries.length = 0;
    await p.commands.get("usage").handler("", p.ctx());
    const out = p.entries
      .filter((e) => e.customType === "picc-control")
      .map((e) => String(e.data?.output ?? ""))
      .join("\n");
    expect(out).toContain("No subagents have been dispatched this session");
  });

  it("sanitizes a control-byte agent name in the /usage report (FIX 4 security)", async () => {
    // agentName derives from agent frontmatter `name`/basename (only trimmed
    // upstream); a hostile ANSI/OSC/control-byte name must not reach the terminal
    // on /usage. Control bytes from code points so this source stays pure ASCII.
    const { p, internals } = wire();
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
    const { p, internals } = wire();

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
    let resolveStop!: (v: unknown) => void;
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
    expect(joined).toContain("insufficient_quota"); // t01 regression: never a silent success
    expect(joined).toContain("settled: aborted"); // outcome vocabulary (status is "stopped")
  });
});

describe("subagent background-task scoping (F13 t02, offline-integration via a real dispatch)", () => {
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
    picc(p.api as never, { onWired: (i) => (internals = i) });
    // Inject the fake SDK into the real runtime BEFORE any dispatch, so the
    // coordinator's registered Agent tool dispatches offline.
    internals.subagentRuntime.setSdkForTest(handle.sdk);

    const coordAgent = p.tools.get("Agent");
    // Two foreground subagent dispatches: each starts ITS OWN nested background
    // task (owner = that subagent's runtime-minted id). run_in_background: false
    // pins them foreground (F15 made dispatch background-by-default) so each outer
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
    expect(ownOut.content[0].text).toContain("inner1 result");

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

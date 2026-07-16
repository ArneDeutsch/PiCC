import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  budgetSkillReinjection,
  renderSkillForActivation,
  skillActivationMessage,
} from "../src/runtime/skill-activation.js";
import { resolveShellBinary } from "../src/engine/shell-inject.js";
import picc from "../src/index.js";
import { fakePi, type FakePi } from "./helpers/fake-pi.js";
import type { ClaudeSettings, ClaudeSkill } from "../src/types.js";

/**
 * Pipeline tests for renderSkillForActivation: args → ${CLAUDE_*} vars →
 * !`cmd` shell injection, with the REAL env construction. settings.env is
 * deliberately minimal here — the spawned shell must inherit process.env
 * (PATH, HOME, SystemRoot, …) on its own, with the Claude overlay on top
 * (regression: skill subprocesses used to run without process.env).
 */

let root: string;

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

function writeSkill(name: string, body: string): ClaudeSkill {
  const dir = path.join(root, ".claude", "skills", name);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "SKILL.md");
  fs.writeFileSync(file, `---\nname: ${name}\ndescription: pipeline test\n---\n${body}`, "utf8");
  return mkSkill(name, file);
}

function mkSkill(name: string, file: string): ClaudeSkill {
  return {
    name,
    description: "pipeline test",
    userInvocable: true,
    disableModelInvocation: false,
    contextFork: false,
    shell: "bash",
    metadata: {},
    baseDir: path.dirname(file),
    source: { path: file, scope: "project" },
    legacyCommand: false,
    unknownKeys: [],
    diagnostics: [],
  };
}

function binAvailable(bin: string, args: string[]): boolean {
  try {
    execFileSync(bin, args, { stdio: "ignore", timeout: 20_000, windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

const hasBash = binAvailable(resolveShellBinary("bash"), ["-c", "exit 0"]);

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "picc-activation-"));
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("renderSkillForActivation", () => {
  it.runIf(hasBash)(
    "injected commands inherit process.env, see the Claude overlay, and get args/vars substituted",
    async () => {
      const skill = writeSkill(
        "env-echo",
        [
          "dir=${CLAUDE_SKILL_DIR}",
          "arg=$0",
          'proj: !`echo "$CLAUDE_PROJECT_DIR"`',
          'inherit: !`echo "$PICC_PIPE_INHERIT"`',
          'overlay: !`echo "$PICC_PIPE_OVERLAY"`',
        ].join("\n"),
      );
      process.env.PICC_PIPE_INHERIT = "inherit-val";
      try {
        const { text, diagnostics } = await renderSkillForActivation({
          skill,
          argsText: "alpha",
          projectRoot: root,
          cwd: root,
          sessionId: "sess-1",
          settings: { ...baseSettings(), env: { PICC_PIPE_OVERLAY: "overlay-val" } },
        });
        expect(diagnostics).toHaveLength(0);
        expect(text).toContain(`dir=${skill.baseDir}`);
        expect(text).toContain("arg=alpha");
        expect(text).toContain(`proj: ${root}`);
        // Inherited from process.env even though settings.env does not carry it.
        expect(text).toContain("inherit: inherit-val");
        // settings.env overlay reaches the subprocess.
        expect(text).toContain("overlay: overlay-val");
      } finally {
        delete process.env.PICC_PIPE_INHERIT;
      }
    },
  );

  it("honors disableSkillShellExecution from settings", async () => {
    const skill = writeSkill("disabled-shell", "out: !`echo nope`");
    const { text, diagnostics } = await renderSkillForActivation({
      skill,
      argsText: "",
      projectRoot: root,
      cwd: root,
      sessionId: "sess-1",
      settings: { ...baseSettings(), disableSkillShellExecution: true },
    });
    expect(text).toContain("[shell execution disabled: echo nope]");
    expect(diagnostics.some((d) => d.severity === "info")).toBe(true);
  });

  it("degrades a missing skill file to a warning diagnostic (never throws)", async () => {
    const skill = mkSkill("gone", path.join(root, "gone", "SKILL.md"));
    const { text, diagnostics } = await renderSkillForActivation({
      skill,
      argsText: "",
      projectRoot: root,
      cwd: root,
      sessionId: "sess-1",
      settings: baseSettings(),
    });
    expect(text).toBe("");
    expect(
      diagnostics.some((d) => d.severity === "warning" && d.message.includes("empty or unreadable")),
    ).toBe(true);
  });

  it("skillActivationMessage wraps the rendered body with the skill header", () => {
    const skill = mkSkill("wrap", path.join(root, "wrap", "SKILL.md"));
    const msg = skillActivationMessage(skill, "BODY TEXT\n");
    expect(msg).toContain(`<skill name="wrap" dir="${skill.baseDir}">`);
    expect(msg).toContain("BODY TEXT");
    expect(msg).toContain("</skill>");
  });

  it("substitutes ${CLAUDE_*} and $ARGUMENTS in allowed-/disallowed-tools without mutating the skill (A3)", async () => {
    const skill = writeSkill("tool-rules", "Body uses $ARGUMENTS.");
    skill.allowedTools = ["Read(${CLAUDE_PROJECT_DIR}/**)", "Bash(deploy $0:*)"];
    skill.disallowedTools = ["Write(${CLAUDE_SKILL_DIR}/*)", "Bash(rm $ARGUMENTS)"];
    const result = await renderSkillForActivation({
      skill,
      argsText: "staging now",
      projectRoot: root,
      cwd: root,
      sessionId: "sess-1",
      settings: baseSettings(),
    });
    expect(result.allowedTools).toEqual([`Read(${root}/**)`, "Bash(deploy staging:*)"]);
    expect(result.disallowedTools).toEqual([
      `Write(${skill.baseDir}/*)`,
      "Bash(rm staging now)",
    ]);
    // Per-activation copies only — the loaded skill object stays raw.
    expect(skill.allowedTools).toEqual(["Read(${CLAUDE_PROJECT_DIR}/**)", "Bash(deploy $0:*)"]);
    expect(skill.disallowedTools).toEqual(["Write(${CLAUDE_SKILL_DIR}/*)", "Bash(rm $ARGUMENTS)"]);
  });
});

// ---------------------------------------------------------------------------
// Compaction re-injection budget (audit A9)
// ---------------------------------------------------------------------------

describe("budgetSkillReinjection", () => {
  it("passes small bodies through untouched, most recently activated first", () => {
    const { text, dropped } = budgetSkillReinjection([
      ["oldest", "OLD BODY"],
      ["newest", "NEW BODY"],
    ]);
    expect(dropped).toEqual([]);
    expect(text.indexOf("### Active skill: newest")).toBeLessThan(
      text.indexOf("### Active skill: oldest"),
    );
    expect(text).toContain("NEW BODY");
    expect(text).toContain("OLD BODY");
    expect(text).not.toContain("[truncated for compaction]");
  });

  it("caps each body at the per-skill budget with a truncation marker", () => {
    const { text } = budgetSkillReinjection([["big", "X".repeat(30)]], {
      perSkillMaxChars: 10,
    });
    expect(text).toBe(`### Active skill: big\n${"X".repeat(10)}\n[truncated for compaction]`);
  });

  it("default per-skill cap is 20,000 chars", () => {
    const { text } = budgetSkillReinjection([["big", "X".repeat(25_000)]]);
    expect(text).toContain("[truncated for compaction]");
    expect(text).toContain("X".repeat(20_000));
    expect(text).not.toContain("X".repeat(20_001));
  });

  it("drops the oldest skills beyond the combined budget and reports them", () => {
    const { text, dropped } = budgetSkillReinjection(
      [
        ["first", "A".repeat(40)],
        ["second", "B".repeat(40)],
        ["third", "C".repeat(40)],
      ],
      { combinedMaxChars: 140 },
    );
    // Recency order: third fits, second fits, first no longer does.
    expect(text).toContain("### Active skill: third");
    expect(text).toContain("### Active skill: second");
    expect(text).not.toContain("### Active skill: first");
    expect(dropped).toEqual(["first"]);
  });

  it("returns empty output for no active skills", () => {
    expect(budgetSkillReinjection([])).toEqual({ text: "", dropped: [] });
  });
});

// ---------------------------------------------------------------------------
// Stacked slash invocations (A7) + re-invocation dedup (A8) — the extension's
// input handler and Skill tool, driven through a fake Pi on a minimal project.
// ---------------------------------------------------------------------------

describe("stacked skill invocations + re-invocation dedup (extension)", () => {
  let projDir: string;
  let pi: FakePi;
  const originalCwd = process.cwd();
  const originalUserDir = process.env.PICC_CLAUDE_USER_DIR;

  function writeProjectSkill(name: string, body: string): void {
    const dir = path.join(projDir, ".claude", "skills", name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "SKILL.md"),
      `---\nname: ${name}\ndescription: ${name} test skill\n---\n${body}\n`,
      "utf8",
    );
  }

  beforeAll(async () => {
    projDir = fs.mkdtempSync(path.join(os.tmpdir(), "picc-stacked-"));
    execFileSync("git", ["init", "-b", "main"], { cwd: projDir, stdio: "ignore" });
    writeProjectSkill("stack-a", "STACK-A-BODY args=[$ARGUMENTS]");
    writeProjectSkill("stack-b", "STACK-B-BODY args=[$ARGUMENTS]");
    writeProjectSkill("stack-c", "STACK-C-BODY without markers");
    for (let i = 1; i <= 6; i++) writeProjectSkill(`stk-${i}`, `STK-${i}-BODY [$ARGUMENTS]`);
    writeProjectSkill("redo", "REDO-BODY [$ARGUMENTS]");
    writeProjectSkill("redo-tool", "REDO-TOOL-BODY [$ARGUMENTS]");
    // Hermetic user scope: don't absorb the developer's real ~/.claude.
    const userDir = path.join(projDir, ".claude-user");
    fs.mkdirSync(userDir, { recursive: true });
    process.env.PICC_CLAUDE_USER_DIR = userDir;
    process.chdir(projDir);
    pi = fakePi();
    picc(pi.api as never, { onInitializationSettled: pi.captureInitialization });
    await pi.waitForInitialization();
    await pi.waitForTools(["bash", "read", "write", "edit", "grep", "find", "ls"]);
  });

  afterAll(() => {
    process.chdir(originalCwd);
    if (originalUserDir === undefined) delete process.env.PICC_CLAUDE_USER_DIR;
    else process.env.PICC_CLAUDE_USER_DIR = originalUserDir;
    try {
      fs.rmSync(projDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
      /* temp dirs are reaped by the OS eventually */
    }
  });

  it("activates stacked leading skills in order; remaining text is the LAST skill's args and appears exactly ONCE (G6)", async () => {
    const result = await pi.fire("input", {
      text: "/stack-a /stack-b build the thing",
      source: "interactive",
    });
    expect(result.action).toBe("transform");
    const text = String(result.text);
    expect(text).toContain("STACK-A-BODY args=[]");
    expect(text).toContain("STACK-B-BODY args=[build the thing]");
    expect(text.indexOf("STACK-A-BODY")).toBeLessThan(text.indexOf("STACK-B-BODY"));
    // The trailing text lives in the last skill's substituted body ONLY — it is
    // no longer re-appended as a separate request part (G6: duplication).
    expect(text.split("build the thing").length - 1).toBe(1);
  });

  it("a marker-less LAST skill still surfaces the trailing text once, via the ARGUMENTS: fallback (G6)", async () => {
    const result = await pi.fire("input", {
      text: "/stack-a /stack-c do it now",
      source: "interactive",
    });
    expect(result.action).toBe("transform");
    const text = String(result.text);
    expect(text).toContain("STACK-C-BODY without markers");
    expect(text).toContain("ARGUMENTS: do it now");
    expect(text.split("do it now").length - 1).toBe(1);
  });

  it("stops at the first token that doesn't resolve; single-skill behavior unchanged", async () => {
    const result = await pi.fire("input", {
      text: "/stack-a /no-such-skill tail text",
      source: "interactive",
    });
    expect(result.action).toBe("transform");
    const text = String(result.text);
    // /no-such-skill doesn't resolve → it and the tail are stack-a's arguments.
    expect(text).toContain("STACK-A-BODY args=[/no-such-skill tail text]");
    // Single-skill invocation: no extra trailing request text is appended.
    expect(text.trimEnd().endsWith("read them only when the instructions require it.")).toBe(true);
  });

  it("parses at most 5 leading skill tokens", async () => {
    const result = await pi.fire("input", {
      text: "/stk-1 /stk-2 /stk-3 /stk-4 /stk-5 /stk-6 tail",
      source: "interactive",
    });
    const text = String(result.text);
    for (let i = 1; i <= 5; i++) expect(text).toContain(`STK-${i}-BODY`);
    // The 6th token is NOT activated — it becomes the 5th skill's arguments.
    expect(text).not.toContain("STK-6-BODY");
    expect(text).toContain("STK-5-BODY [/stk-6 tail]");
  });

  it("substitutes a short note for a byte-identical re-invocation via slash command (A8)", async () => {
    const first = await pi.fire("input", { text: "/redo same-args", source: "interactive" });
    expect(String(first.text)).toContain("REDO-BODY [same-args]");

    const second = await pi.fire("input", { text: "/redo same-args", source: "interactive" });
    expect(String(second.text)).toContain(
      `Skill "redo" was invoked again; its content is unchanged from the earlier copy above.`,
    );
    expect(String(second.text)).not.toContain("REDO-BODY");

    // Different args → different rendering → full content again.
    const third = await pi.fire("input", { text: "/redo other-args", source: "interactive" });
    expect(String(third.text)).toContain("REDO-BODY [other-args]");
    expect(String(third.text)).not.toContain("was invoked again");
  });

  it("substitutes the dedup note on identical Skill-tool re-invocations too", async () => {
    const skillTool = pi.tools.get("Skill");
    const first = await skillTool.execute("d1", { name: "redo-tool", arguments: "x" });
    expect(first.content[0].text).toContain("REDO-TOOL-BODY [x]");

    const second = await skillTool.execute("d2", { name: "redo-tool", arguments: "x" });
    expect(second.content[0].text).toBe(
      `Skill "redo-tool" was invoked again; its content is unchanged from the earlier copy above.`,
    );
    expect(second.details.deduplicated).toBe(true);

    const third = await skillTool.execute("d3", { name: "redo-tool", arguments: "y" });
    expect(third.content[0].text).toContain("REDO-TOOL-BODY [y]");
  });
});

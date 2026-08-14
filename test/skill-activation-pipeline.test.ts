import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  budgetSkillReinjection,
  recordResidentSkill,
  renderSkillForActivation,
  skillActivationMessage,
} from "../src/runtime/skill-activation.js";
import { resolveShellBinary } from "../src/engine/shell-inject.js";
import picc, { pluginRuntimeContextForSource } from "../src/index.js";
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

describe("qualified plugin skill activation", () => {
  it("renders the exact qualified context when two marketplaces share a bare name", async () => {
    const skill = writeSkill("qualified-selection", "root=${CLAUDE_PLUGIN_ROOT};data=${CLAUDE_PLUGIN_DATA}");
    skill.source.pluginId = "same@market-b";
    skill.source.pluginName = "same";
    const first = {
      pluginId: "same@market-a", pluginName: "same", root: path.join(root, "market-a"),
      dataDir: path.join(root, "data-a"), projectDir: root,
    };
    const second = {
      pluginId: "same@market-b", pluginName: "same", root: path.join(root, "market-b"),
      dataDir: path.join(root, "data-b"), projectDir: root,
    };
    const selected = pluginRuntimeContextForSource(skill.source, new Map([
      [first.pluginId, first], [second.pluginId, second],
    ]));
    const result = await renderSkillForActivation({
      skill, argsText: "", projectRoot: root, cwd: root, sessionId: "session",
      settings: baseSettings(), pluginContext: selected, ensurePluginDataDir: () => ({ ok: true }),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.message);
    expect(result.text).toBe(`root=${second.root};data=${second.dataDir}`);
    expect(result.text).not.toContain(first.root);
  });

  it("creates plugin data only on reference and fails visibly when creation fails", async () => {
    const skill = writeSkill("plugin-data", "state=${CLAUDE_PLUGIN_DATA}/state.json");
    skill.source.pluginId = "plugin-data@market";
    skill.source.pluginName = "plugin-data";
    const context = {
      pluginId: "plugin-data@market",
      pluginName: "plugin-data",
      root: path.join(root, "installed-root"),
      dataDir: path.join(root, "plugin-data-dir"),
      projectDir: root,
    };
    const findings: string[] = [];
    const failed = await renderSkillForActivation({
      skill,
      argsText: "",
      projectRoot: root,
      cwd: root,
      sessionId: "session",
      settings: baseSettings(),
      pluginContext: context,
      ensurePluginDataDir: () => ({ ok: false, message: "contained mkdir failed" }),
      onRuntimeFinding: (message) => findings.push(message),
    });
    expect(failed).toMatchObject({ ok: false });
    if (failed.ok) throw new Error("expected activation failure");
    expect(failed.message).toContain("contained mkdir failed");
    expect(findings[0]).toContain("contained mkdir failed");

    const missingCallback = await renderSkillForActivation({
      skill,
      argsText: "",
      projectRoot: root,
      cwd: root,
      sessionId: "session",
      settings: baseSettings(),
      pluginContext: context,
      onRuntimeFinding: (message) => findings.push(message),
    });
    expect(missingCallback).toMatchObject({ ok: false });
    if (missingCallback.ok) throw new Error("expected missing callback to fail activation");
    expect(missingCallback.message).toContain("Inspect exact ownership with /plugin details <qualified identity>");
    expect(missingCallback.message).toContain("use the applicable focused action or picc plugin --help for exact PiCC-owned changes, or repair imported state through Claude Code");
    expect(missingCallback.message).toContain("run /reload-plugins in the interactive TUI or start a new PiCC session");
    expect(missingCallback.message).not.toContain("PiCC lifecycle");
    expect(missingCallback.message).not.toMatch(/retry|no reload/i);
    expect(findings).toContain(missingCallback.message);

    fs.writeFileSync(skill.source.path, "---\nname: plugin-data\ndescription: pipeline test\n---\nno data variable", "utf8");
    let creationCalls = 0;
    const quiet = await renderSkillForActivation({
      skill,
      argsText: "",
      projectRoot: root,
      cwd: root,
      sessionId: "session",
      settings: baseSettings(),
      pluginContext: context,
      ensurePluginDataDir: () => { creationCalls += 1; return { ok: true }; },
    });
    expect(quiet.ok).toBe(true);
    if (!quiet.ok) throw new Error(quiet.message);
    expect(quiet.text).toContain("no data variable");
    expect(creationCalls).toBe(0);
  });

  it.runIf(hasBash)(
    "returns the authoritative typed failure without shell egress when the runtime-finding observer throws",
    async () => {
      const marker = path.join(root, "throwing-observer-shell-marker");
      const shellMarker = marker.split(path.sep).join("/");
      const skill = writeSkill(
        "throwing-observer",
        "state=${CLAUDE_PLUGIN_DATA}/state.json\nreached: !`printf reached > \"$PICC_OBSERVER_THROW_MARKER\"`",
      );
      skill.source.pluginId = "throwing-observer@market";
      skill.source.pluginName = "throwing-observer";
      const context = {
        pluginId: "throwing-observer@market",
        pluginName: "throwing-observer",
        root: path.join(root, "throwing-observer-root"),
        dataDir: path.join(root, "throwing-observer-data"),
        projectDir: root,
      };
      const message = "contained mkdir failed";
      let observerCalls = 0;

      fs.rmSync(marker, { force: true });
      try {
        const result = await renderSkillForActivation({
          skill,
          argsText: "",
          projectRoot: root,
          cwd: root,
          sessionId: "session",
          settings: {
            ...baseSettings(),
            env: { PICC_OBSERVER_THROW_MARKER: shellMarker },
          },
          pluginContext: context,
          ensurePluginDataDir: () => ({ ok: false, message }),
          onRuntimeFinding: () => { observerCalls += 1; throw new Error("observer failed"); },
        });

        expect(observerCalls).toBe(1);
        expect(result).toEqual({
          ok: false,
          message,
          diagnostics: [{ severity: "warning", message, source: skill.source.path }],
        });
        expect(fs.existsSync(marker)).toBe(false);
      } finally {
        fs.rmSync(marker, { force: true });
      }
    },
  );
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
        const result = await renderSkillForActivation({
          skill,
          argsText: "alpha",
          projectRoot: root,
          cwd: root,
          sessionId: "sess-1",
          settings: { ...baseSettings(), env: { PICC_PIPE_OVERLAY: "overlay-val" } },
        });
        expect(result.ok).toBe(true);
        if (!result.ok) throw new Error(result.message);
        const { text, diagnostics } = result;
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
    const result = await renderSkillForActivation({
      skill,
      argsText: "",
      projectRoot: root,
      cwd: root,
      sessionId: "sess-1",
      settings: { ...baseSettings(), disableSkillShellExecution: true },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.message);
    const { text, diagnostics } = result;
    expect(text).toContain("[shell execution disabled: echo nope]");
    expect(diagnostics.some((d) => d.severity === "info")).toBe(true);
  });

  it("degrades a missing skill file to a warning diagnostic (never throws)", async () => {
    const skill = mkSkill("gone", path.join(root, "gone", "SKILL.md"));
    const result = await renderSkillForActivation({
      skill,
      argsText: "",
      projectRoot: root,
      cwd: root,
      sessionId: "sess-1",
      settings: baseSettings(),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.message);
    const { text, diagnostics } = result;
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

  it("detects plugin data introduced by named arguments and final tool-rule substitution", async () => {
    const skill = writeSkill("late-data", "target=$target");
    skill.source.pluginId = "late-data@market";
    skill.source.pluginName = "late-data";
    skill.arguments = [{ name: "target" }];
    skill.allowedTools = ["Read($0)"];
    const context = {
      pluginId: "late-data@market",
      pluginName: "late-data",
      root: path.join(root, "late-root"),
      dataDir: path.join(root, "late-data"),
      projectDir: root,
    };
    let calls = 0;
    const result = await renderSkillForActivation({
      skill,
      argsText: "${CLAUDE_PLUGIN_DATA}",
      projectRoot: root,
      cwd: root,
      sessionId: "sess-1",
      settings: baseSettings(),
      pluginContext: context,
      ensurePluginDataDir: () => { calls += 1; return { ok: true }; },
    });
    expect(result.ok).toBe(true);
    expect(calls).toBe(1);
  });

  it("ignores unused raw arguments but still prepares data for raw tool-rule references", async () => {
    const context = {
      pluginId: "lazy-data@market", pluginName: "lazy-data", root: "/plugins/lazy",
      dataDir: "/data/lazy", projectDir: root,
    };
    const unused = writeSkill("unused-data-argument", "used=$0");
    unused.source.pluginId = context.pluginId;
    unused.source.pluginName = context.pluginName;
    let calls = 0;
    const unusedResult = await renderSkillForActivation({
      skill: unused,
      argsText: "safe ${CLAUDE_PLUGIN_DATA}",
      projectRoot: root,
      cwd: root,
      sessionId: "sess-1",
      settings: baseSettings(),
      pluginContext: context,
      ensurePluginDataDir: () => { calls += 1; return { ok: true }; },
    });
    expect(unusedResult.ok).toBe(true);
    expect(calls).toBe(0);

    const ruled = writeSkill("raw-data-rule", "body without data");
    ruled.source.pluginId = context.pluginId;
    ruled.source.pluginName = context.pluginName;
    ruled.disallowedTools = ["Write(${CLAUDE_PLUGIN_DATA}/blocked)"];
    const ruledResult = await renderSkillForActivation({
      skill: ruled,
      argsText: "unused",
      projectRoot: root,
      cwd: root,
      sessionId: "sess-1",
      settings: baseSettings(),
      pluginContext: context,
      ensurePluginDataDir: () => { calls += 1; return { ok: true }; },
    });
    expect(ruledResult.ok).toBe(true);
    expect(calls).toBe(1);
  });

  it("substitutes ${CLAUDE_*} and $ARGUMENTS in allowed-/disallowed-tools without mutating the skill", async () => {
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
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.message);
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
// Compaction re-injection budget
// ---------------------------------------------------------------------------

describe("budgetSkillReinjection", () => {
  it("moves a reactivated skill to newest order with only its latest rendering", () => {
    const active = new Map<string, string>([["first", "OLD"], ["second", "SECOND"]]);
    recordResidentSkill(active, "first", "NEW");
    expect([...active.entries()]).toEqual([["second", "SECOND"], ["first", "NEW"]]);
    expect(budgetSkillReinjection([...active.entries()]).text.indexOf("NEW"))
      .toBeLessThan(budgetSkillReinjection([...active.entries()]).text.indexOf("SECOND"));
  });

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
// Stacked slash invocations + re-invocation dedup — the extension's
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

  it("activates stacked leading skills in order; remaining text is the LAST skill's args and appears exactly ONCE", async () => {
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

  it("a marker-less LAST skill still surfaces the trailing text once, via the ARGUMENTS: fallback", async () => {
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

  it("substitutes a short note for a byte-identical re-invocation via slash command", async () => {
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

  // Control for the image-preservation fix: when nothing transforms the input
  // (no skill token, and this minimal project has no UserPromptSubmit hook), the
  // handler returns `continue` and never touches `event.images` — Pi keeps the
  // original event, so a captured image is preserved by pass-through.
  it("leaves captured images untouched when no transform fires (continue pass-through)", async () => {
    const image = { type: "image", source: { type: "base64", media_type: "image/png", data: "CCCC=" } };
    const result = await pi.fire("input", {
      text: "just a plain message with a pasted screenshot",
      images: [image],
      source: "interactive",
    });
    // `continue` = Pi reuses the original event (images intact); the handler does
    // not synthesize its own `images` on this path.
    expect(result).toEqual({ action: "continue" });
  });
});

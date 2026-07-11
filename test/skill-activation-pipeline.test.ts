import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  renderSkillForActivation,
  skillActivationMessage,
} from "../src/runtime/skill-activation.js";
import { resolveShellBinary } from "../src/engine/shell-inject.js";
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
          "arg=$1",
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
});

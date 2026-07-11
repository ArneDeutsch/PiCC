import path from "node:path";
import type { ClaudeSettings, ClaudeSkill, Diagnostic } from "../types.js";
import { loadSkillBody, substituteArguments, substituteVariables } from "../claude/skills.js";
import { preprocessShellInjection } from "../engine/shell-inject.js";

/**
 * The skill activation pipeline (plan §4.1): lazy body load → argument substitution →
 * ${CLAUDE_*} variable substitution → !`cmd` shell-injection preprocessing.
 * Used by the Skill tool, slash commands, and context:fork dispatch alike.
 */
export async function renderSkillForActivation(opts: {
  skill: ClaudeSkill;
  argsText: string;
  projectRoot: string;
  cwd: string;
  sessionId: string;
  effort?: string;
  settings: ClaudeSettings;
  pluginRoot?: string;
  pluginData?: string;
}): Promise<{ text: string; diagnostics: Diagnostic[] }> {
  const diagnostics: Diagnostic[] = [];
  const body = loadSkillBody(opts.skill);
  if (!body) {
    diagnostics.push({
      severity: "warning",
      message: `Skill "${opts.skill.name}" has an empty or unreadable body`,
      source: opts.skill.source.path,
    });
  }

  const args = substituteArguments(body, opts.argsText, opts.skill.arguments);
  diagnostics.push(...args.diagnostics);

  const withVars = substituteVariables(args.text, {
    CLAUDE_SKILL_DIR: opts.skill.baseDir,
    CLAUDE_PROJECT_DIR: opts.projectRoot,
    CLAUDE_SESSION_ID: opts.sessionId,
    CLAUDE_EFFORT: opts.effort ?? "",
    CLAUDE_PLUGIN_ROOT: opts.pluginRoot ?? opts.skill.baseDir,
    CLAUDE_PLUGIN_DATA: opts.pluginData ?? path.join(opts.projectRoot, ".claude", ".piclaudex", "plugin-data"),
  });

  const injected = await preprocessShellInjection(withVars, {
    shell: opts.skill.shell,
    cwd: opts.cwd,
    env: { ...opts.settings.env, CLAUDE_PROJECT_DIR: opts.projectRoot },
    disabled: opts.settings.disableSkillShellExecution,
  });
  diagnostics.push(...injected.diagnostics);

  return { text: injected.text, diagnostics };
}

/** Header line prepended when a skill enters context (mirrors Claude's command-message). */
export function skillActivationMessage(skill: ClaudeSkill, rendered: string): string {
  return [
    `<skill name="${skill.name}" dir="${skill.baseDir}">`,
    rendered.trim(),
    `</skill>`,
    ``,
    `Follow the skill instructions above now. Bundled files (references/, templates, scripts) live in ${skill.baseDir} — read them only when the instructions require it.`,
  ].join("\n");
}

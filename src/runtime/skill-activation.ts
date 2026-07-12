import path from "node:path";
import type { ClaudeSettings, ClaudeSkill, Diagnostic } from "../types.js";
import {
  loadSkillBody,
  substituteArguments,
  substituteToolRules,
  substituteVariables,
} from "../claude/skills.js";
import { preprocessShellInjection } from "../engine/shell-inject.js";

/** The `${CLAUDE_*}` variable set a skill activation substitutes (body + tool rules). */
export function skillActivationVars(opts: {
  skill: ClaudeSkill;
  projectRoot: string;
  sessionId: string;
  effort?: string;
  pluginRoot?: string;
  pluginData?: string;
}): Record<string, string> {
  return {
    CLAUDE_SKILL_DIR: opts.skill.baseDir,
    CLAUDE_PROJECT_DIR: opts.projectRoot,
    CLAUDE_SESSION_ID: opts.sessionId,
    CLAUDE_EFFORT: opts.effort ?? "",
    CLAUDE_PLUGIN_ROOT: opts.pluginRoot ?? opts.skill.baseDir,
    CLAUDE_PLUGIN_DATA:
      opts.pluginData ?? path.join(opts.projectRoot, ".claude", ".picc", "plugin-data"),
  };
}

/**
 * The skill activation pipeline (plan §4.1): lazy body load → argument substitution →
 * ${CLAUDE_*} variable substitution → !`cmd` shell-injection preprocessing.
 * Used by the Skill tool, slash commands, and context:fork dispatch alike.
 * `allowedTools`/`disallowedTools` are per-activation copies with the same
 * variable + argument substitution applied (audit A3); the skill object itself
 * is never mutated.
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
}): Promise<{
  text: string;
  diagnostics: Diagnostic[];
  allowedTools?: string[];
  disallowedTools?: string[];
}> {
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

  const vars = skillActivationVars(opts);
  const withVars = substituteVariables(args.text, vars);

  const injected = await preprocessShellInjection(withVars, {
    shell: opts.skill.shell,
    cwd: opts.cwd,
    // Overlay only: the spawned shell inherits the full process.env (PATH,
    // HOME, SystemRoot, …) with these Claude-specific vars layered on top.
    env: { ...opts.settings.env, CLAUDE_PROJECT_DIR: opts.projectRoot },
    disabled: opts.settings.disableSkillShellExecution,
  });
  diagnostics.push(...injected.diagnostics);

  return {
    text: injected.text,
    diagnostics,
    allowedTools: substituteToolRules(
      opts.skill.allowedTools,
      opts.argsText,
      vars,
      opts.skill.arguments,
    ),
    disallowedTools: substituteToolRules(
      opts.skill.disallowedTools,
      opts.argsText,
      vars,
      opts.skill.arguments,
    ),
  };
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

/** Per-skill compaction re-injection cap (~5k tokens, Claude's carryover budget). */
export const REINJECT_PER_SKILL_MAX_CHARS = 20_000;
/** Combined compaction re-injection cap (~25k tokens). */
export const REINJECT_COMBINED_MAX_CHARS = 100_000;

/**
 * Budget the post-compaction re-injection of active skill bodies (audit A9) —
 * also reused for the resident "Active skills" system-prompt section (G7):
 * most recently activated skills first, each body capped at ~5k tokens with a
 * `[truncated for compaction]` marker, the combined payload capped at ~25k
 * tokens. Skills that no longer fit are dropped and reported via `dropped`
 * so the caller can surface an info diagnostic. Never throws.
 */
export function budgetSkillReinjection(
  /** [name, rendered body] in ACTIVATION order (oldest first, e.g. Map entries). */
  active: Array<[string, string]>,
  opts: { perSkillMaxChars?: number; combinedMaxChars?: number } = {},
): { text: string; dropped: string[] } {
  const perMax = opts.perSkillMaxChars ?? REINJECT_PER_SKILL_MAX_CHARS;
  const combinedMax = opts.combinedMaxChars ?? REINJECT_COMBINED_MAX_CHARS;
  const sections: string[] = [];
  const dropped: string[] = [];
  let total = 0;
  for (const [name, body] of [...active].reverse()) {
    const capped =
      body.length > perMax ? `${body.slice(0, perMax)}\n[truncated for compaction]` : body;
    const section = `### Active skill: ${name}\n${capped}`;
    const cost = section.length + (sections.length > 0 ? 2 : 0); // +2 for the joining "\n\n"
    if (total + cost > combinedMax) {
      dropped.push(name);
      continue;
    }
    sections.push(section);
    total += cost;
  }
  return { text: sections.join("\n\n"), dropped };
}

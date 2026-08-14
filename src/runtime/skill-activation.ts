import path from "node:path";
import type { ClaudeSettings, ClaudeSkill, Diagnostic, PluginRuntimeContext } from "../types.js";
import {
  loadSkillBodyResult,
  substituteArguments,
  substituteToolRules,
  substituteVariables,
} from "../claude/skills.js";
import { preprocessShellInjection } from "../engine/shell-inject.js";
import type { HookRunnerLike } from "../engine/hook-runner.js";

function boundedRuntimeLabel(value: string): string {
  const neutral = value.replace(/[\u0000-\u001f\u007f]/g, "?");
  return neutral.length <= 128 ? neutral : `${neutral.slice(0, 127)}…`;
}

const PLUGIN_RECONCILE_RECOVERY = "Inspect exact ownership with /plugin details <qualified identity>, then use the applicable focused action or picc plugin --help for exact PiCC-owned changes, or repair imported state through Claude Code; afterward, run /reload-plugins in the interactive TUI or start a new PiCC session.";

/** Mutable preservation state owned by one main session or one child dispatch. */
export interface SkillActivationState {
  activeSkills: Map<string, string>;
  denyRules: Map<string, string[]>;
  scopedHookSkills: Set<string>;
  hookRunners: HookRunnerLike[];
  lastRenderHash: Map<string, string>;
  /** Child dispatches identity-wrap runners created by later skill activations. */
  wrapHookRunner?: (runner: HookRunnerLike) => HookRunnerLike;
}

export function newSkillActivationState(
  activeSkills = new Map<string, string>(),
  wrapHookRunner?: (runner: HookRunnerLike) => HookRunnerLike,
): SkillActivationState {
  return {
    activeSkills,
    denyRules: new Map(),
    scopedHookSkills: new Set(),
    hookRunners: [],
    lastRenderHash: new Map(),
    ...(wrapHookRunner ? { wrapHookRunner } : {}),
  };
}

/** The `${CLAUDE_*}` variable set a skill activation substitutes (body + tool rules). */
export function skillActivationVars(opts: {
  skill: ClaudeSkill;
  projectRoot: string;
  sessionId: string;
  effort?: string;
  pluginContext?: PluginRuntimeContext;
}): Record<string, string> {
  return {
    CLAUDE_SKILL_DIR: opts.skill.baseDir,
    CLAUDE_PROJECT_DIR: opts.pluginContext?.projectDir ?? opts.projectRoot,
    CLAUDE_SESSION_ID: opts.sessionId,
    CLAUDE_EFFORT: opts.effort ?? "",
    CLAUDE_PLUGIN_ROOT: opts.pluginContext?.root ?? opts.skill.baseDir,
    CLAUDE_PLUGIN_DATA:
      opts.pluginContext?.dataDir ?? path.join(opts.projectRoot, ".claude", ".picc", "plugin-data"),
  };
}

/**
 * The skill activation pipeline: lazy body load → argument substitution →
 * ${CLAUDE_*} variable substitution → !`cmd` shell-injection preprocessing.
 * Used by the Skill tool, slash commands, and context:fork dispatch alike.
 * `allowedTools`/`disallowedTools` are per-activation copies with the same
 * variable + argument substitution applied; the skill object itself is never
 * mutated.
 */
export type SkillActivationRenderResult =
  | {
      ok: true;
      text: string;
      diagnostics: Diagnostic[];
      allowedTools?: string[];
      disallowedTools?: string[];
    }
  | { ok: false; message: string; diagnostics: Diagnostic[] };

export async function renderSkillForActivation(opts: {
  skill: ClaudeSkill;
  argsText: string;
  projectRoot: string;
  cwd: string;
  sessionId: string;
  effort?: string;
  settings: ClaudeSettings;
  pluginContext?: PluginRuntimeContext;
  ensurePluginDataDir?: (context: PluginRuntimeContext, component: string) => { ok: true } | { ok: false; message: string };
  onRuntimeFinding?: (message: string) => void;
}): Promise<SkillActivationRenderResult> {
  const diagnostics: Diagnostic[] = [];
  const fail = (message: string): SkillActivationRenderResult => {
    diagnostics.push({ severity: "warning", message, source: opts.skill.source.path });
    try {
      opts.onRuntimeFinding?.(message);
    } catch {
      // Runtime finding observers are presentation-only.
    }
    return { ok: false, message, diagnostics };
  };
  const loaded = loadSkillBodyResult(opts.skill);
  diagnostics.push(...loaded.diagnostics);
  if (loaded.failure) {
    return fail(`Skill "${boundedRuntimeLabel(opts.skill.name)}" could not activate because its installed plugin body is no longer readable or contained. ${PLUGIN_RECONCILE_RECOVERY}`);
  }
  const body = loaded.body;
  if (!body) {
    diagnostics.push({
      severity: "warning",
      message: `Skill "${opts.skill.name}" has an empty or unreadable body`,
      source: opts.skill.source.path,
    });
  }

  if (opts.skill.source.pluginId && !opts.pluginContext) {
    return fail(`Skill "${boundedRuntimeLabel(opts.skill.name)}" could not activate because runtime context for plugin "${boundedRuntimeLabel(opts.skill.source.pluginId)}" is unavailable. ${PLUGIN_RECONCILE_RECOVERY}`);
  }

  const args = substituteArguments(body, opts.argsText, opts.skill.arguments);
  diagnostics.push(...args.diagnostics);
  const vars = skillActivationVars(opts);
  const allowedTools = substituteToolRules(
    opts.skill.allowedTools,
    opts.argsText,
    vars,
    opts.skill.arguments,
  );
  const disallowedTools = substituteToolRules(
    opts.skill.disallowedTools,
    opts.argsText,
    vars,
    opts.skill.arguments,
  );
  const rawToolRules = [...(opts.skill.allowedTools ?? []), ...(opts.skill.disallowedTools ?? [])];
  const finalToolRules = [...(allowedTools ?? []), ...(disallowedTools ?? [])];
  const referencesPluginData = [args.text, ...rawToolRules, ...finalToolRules]
    .some((value) => /\$\{CLAUDE_PLUGIN_DATA\}|\$CLAUDE_PLUGIN_DATA(?![A-Za-z0-9_])/.test(value));
  if (opts.pluginContext && referencesPluginData) {
    const ensured = opts.ensurePluginDataDir?.(opts.pluginContext, `skill ${boundedRuntimeLabel(opts.skill.name)}`);
    if (!ensured || !ensured.ok) {
      const message = ensured && !ensured.ok
        ? ensured.message
        : `Skill "${boundedRuntimeLabel(opts.skill.name)}" could not prepare persistent data for plugin "${boundedRuntimeLabel(opts.pluginContext.pluginId)}". ${PLUGIN_RECONCILE_RECOVERY}`;
      return fail(message);
    }
  }

  const withVars = substituteVariables(args.text, vars);

  const injected = await preprocessShellInjection(withVars, {
    shell: opts.skill.shell,
    cwd: opts.cwd,
    // Overlay only: the spawned shell inherits the full process.env (PATH,
    // HOME, SystemRoot, …) with these Claude-specific vars layered on top.
    env: {
      ...opts.settings.env,
      CLAUDE_PROJECT_DIR: opts.pluginContext?.projectDir ?? opts.projectRoot,
      ...(opts.pluginContext
        ? {
            CLAUDE_PLUGIN_ROOT: opts.pluginContext.root,
            CLAUDE_PLUGIN_DATA: opts.pluginContext.dataDir,
          }
        : {}),
    },
    disabled: opts.settings.disableSkillShellExecution,
  });
  diagnostics.push(...injected.diagnostics);

  return {
    ok: true,
    text: injected.text,
    diagnostics,
    allowedTools,
    disallowedTools,
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

/** Replace a resident skill while moving its latest rendering to activation-recency order. */
export function recordResidentSkill(active: Map<string, string>, name: string, rendered: string): void {
  active.delete(name);
  active.set(name, rendered);
}

/** PiCC heuristic character cap for each latest rendered skill body restored after compaction. */
export const REINJECT_PER_SKILL_MAX_CHARS = 20_000;
/** PiCC heuristic combined character cap for restored latest rendered skill bodies. */
export const REINJECT_COMBINED_MAX_CHARS = 100_000;

/**
 * Budget the post-compaction re-injection of active skill bodies — also reused
 * for the resident "Active skills" system-prompt section:
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

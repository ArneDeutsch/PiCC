import os from "node:os";
import path from "node:path";
import type { ClaudeProject, ClaudeSkill, Diagnostic, HookConfig } from "./types.js";
import { discoverArtifactDirs, resolveProjectRoot, dedupeByName } from "./discovery/locations.js";
import { loadSettings } from "./discovery/settings.js";
import { loadSkills } from "./claude/skills.js";
import { loadAgents } from "./claude/agents.js";
import { loadRules } from "./claude/rules.js";
import { loadClaudeMdHierarchy } from "./claude/claude-md.js";
import { loadAutoMemory, type MemorySnapshot } from "./claude/memory.js";
import { parseHookConfig, mergeHookConfigs } from "./claude/hooks.js";
import {
  discoverInstalledPlugins,
  discoverProjectBundledPlugin,
  loadPluginHooks,
  type InstalledPlugin,
} from "./claude/plugins.js";

/**
 * Assemble the full Claude-artifact model of a project (plan §3): settings with
 * precedence, skills, agents, rules, CLAUDE.md hierarchy, and installed-plugin
 * content folded into the same registries.
 */
export interface LoadedProject extends ClaudeProject {
  /** Fully merged hook config: settings hooks + plugin hooks. */
  mergedHooks: HookConfig;
  plugins: InstalledPlugin[];
  pluginRoots: Record<string, string>;
  /** Auto memory (audit B4): dir + truncated MEMORY.md; undefined when disabled. */
  autoMemory?: MemorySnapshot;
}

export function loadClaudeProject(opts: {
  cwd: string;
  userDir?: string;
  /** Override managed/policy settings file locations (used by tests). */
  managedSettingsPaths?: string[];
  /** Override managed/policy artifact base directories (used by tests). */
  managedArtifactDirs?: string[];
}): LoadedProject {
  const diagnostics: Diagnostic[] = [];
  const cwd = path.resolve(opts.cwd);
  const userDir = opts.userDir ?? path.join(os.homedir(), ".claude");
  const root = resolveProjectRoot(cwd);

  const settings = loadSettings({
    cwd,
    projectRoot: root,
    userDir,
    managedPaths: opts.managedSettingsPaths,
  });
  const dirs = discoverArtifactDirs({
    cwd,
    projectRoot: root,
    userDir,
    managedDirs: opts.managedArtifactDirs,
  });

  // Plugins: user-installed + project-bundled.
  const pluginResult = discoverInstalledPlugins({
    userDir,
    enabledPlugins: settings.enabledPlugins,
  });
  diagnostics.push(...pluginResult.diagnostics);
  const plugins = pluginResult.plugins.filter((p) => p.enabled);
  const bundled = discoverProjectBundledPlugin(root);
  if (bundled) plugins.push(bundled);
  // Per-plugin diagnostics (malformed manifests, dangling manifest paths, …)
  // must surface into the project diagnostics for /doctor and the compat report.
  for (const p of plugins) diagnostics.push(...p.diagnostics);
  const pluginRoots: Record<string, string> = {};
  for (const p of plugins) pluginRoots[p.name] = p.root;

  // Skills & commands (project/user scope first, then plugin content; first-wins
  // dedupe). Plugin content is namespaced `<plugin>:<name>` exactly like Claude
  // Code (research doc §1.5/§1.6: plugin skills "never collide"), so a plugin
  // skill is never silently shadowed by a same-named project/user skill.
  const skillsResult = loadSkills(dirs.skillDirs, dirs.commandDirs);
  diagnostics.push(...skillsResult.diagnostics);
  let skills = skillsResult.skills;
  for (const plugin of plugins) {
    const pluginSkills = loadSkills(
      plugin.skillDirs.map((dir) => ({ dir, scope: "plugin" as const })),
      plugin.commandDirs.map((dir) => ({ dir, scope: "plugin" as const })),
      { pluginName: plugin.name },
    );
    diagnostics.push(...pluginSkills.diagnostics);
    skills = dedupeByName([...skills, ...namespacePluginContent(pluginSkills.skills, plugin.name)]);
  }

  // Agents (plugin agents get the same `<plugin>:<name>` scoped ids, research doc §2.3).
  const agentsResult = loadAgents(dirs.agentDirs);
  diagnostics.push(...agentsResult.diagnostics);
  let agents = agentsResult.agents;
  for (const plugin of plugins) {
    const pluginAgents = loadAgents(
      plugin.agentDirs.map((dir) => ({ dir, scope: "plugin" as const })),
      { pluginName: plugin.name },
    );
    diagnostics.push(...pluginAgents.diagnostics);
    agents = dedupeByName([...agents, ...namespacePluginContent(pluginAgents.agents, plugin.name)]);
  }

  // skillOverrides (settings, any scope): per-skill disable/downgrade.
  skills = applySkillOverrides(skills, settings.skillOverrides, diagnostics);

  // Rules.
  const rulesResult = loadRules(dirs.ruleDirs, {
    excludes: settings.claudeMdExcludes,
    projectRoot: root,
  });
  diagnostics.push(...rulesResult.diagnostics);

  // CLAUDE.md hierarchy (managed CLAUDE.md + inline managed `claudeMd` first — B3).
  const claudeMdResult = loadClaudeMdHierarchy({
    cwd,
    projectRoot: root,
    userDir,
    excludes: settings.claudeMdExcludes,
    managedDirs: opts.managedArtifactDirs,
    managedInline: settings.managedClaudeMd,
  });
  diagnostics.push(...claudeMdResult.diagnostics);

  // Auto memory, read side (B4): undefined when disabled by setting or env.
  const autoMemory = loadAutoMemory(root, userDir, settings);

  // Hooks: settings hooks + plugin hooks.
  const hookConfigs: HookConfig[] = [settings.hooks];
  for (const plugin of plugins) {
    const rawHooks = loadPluginHooks(plugin);
    diagnostics.push(...rawHooks.diagnostics);
    if (Object.keys(rawHooks.config).length) {
      const parsed = parseHookConfig(rawHooks.config, `plugin:${plugin.name}`);
      diagnostics.push(...parsed.diagnostics);
      hookConfigs.push(parsed.config);
    }
  }

  return {
    root,
    cwd,
    userDir,
    settings,
    skills,
    agents,
    rules: rulesResult.rules,
    claudeMd: claudeMdResult.files,
    diagnostics,
    mergedHooks: mergeHookConfigs(...hookConfigs),
    plugins,
    pluginRoots,
    autoMemory,
  };
}

/**
 * Claude Code namespaces plugin skills/agents/commands as `plugin-name:name`
 * (research doc §1.6 "Plugin `my-plugin/skills/review/` → `/my-plugin:review`").
 * The bare name stays reachable via {@link findByName} when unambiguous.
 */
function namespacePluginContent<T extends { name: string }>(items: T[], pluginName: string): T[] {
  return items.map((item) =>
    item.name.startsWith(`${pluginName}:`) ? item : { ...item, name: `${pluginName}:${item.name}` },
  );
}

/**
 * Resolve a skill or agent by name: exact match first; for a bare (colon-free)
 * name, a UNIQUE `…:<name>` suffix match resolves plugin-namespaced content.
 */
export function findByName<T extends { name: string }>(items: T[], name: string): T | undefined {
  const exact = items.find((item) => item.name === name);
  if (exact) return exact;
  if (name.includes(":")) return undefined;
  const suffixMatches = items.filter((item) => item.name.endsWith(`:${name}`));
  return suffixMatches.length === 1 ? suffixMatches[0] : undefined;
}

/**
 * Apply the settings `skillOverrides` map (research doc §1.7): per skill name,
 * `"off"` removes the skill, `"user-invocable-only"` hides it from the model
 * listing, `"name-only"` lists it without a description, `"on"` is a no-op.
 * Unknown values degrade to a diagnostic (never throw).
 */
function applySkillOverrides(
  skills: ClaudeSkill[],
  overrides: Record<string, unknown>,
  diagnostics: Diagnostic[],
): ClaudeSkill[] {
  const out: ClaudeSkill[] = [];
  for (const skill of skills) {
    // Object.hasOwn: override keys come from project JSON — never read inherited members.
    const value = Object.hasOwn(overrides, skill.name) ? overrides[skill.name] : undefined;
    if (value === undefined) {
      out.push(skill);
      continue;
    }
    const mode = typeof value === "string" ? value.trim().toLowerCase() : value;
    if (mode === "off" || mode === false) {
      diagnostics.push({
        severity: "info",
        message: `Skill "${skill.name}" disabled by skillOverrides`,
        source: skill.source.path,
      });
      continue;
    }
    if (mode === "user-invocable-only") {
      out.push({ ...skill, disableModelInvocation: true });
      continue;
    }
    if (mode === "name-only") {
      out.push({ ...skill, description: "", whenToUse: undefined });
      continue;
    }
    if (mode !== "on" && mode !== true) {
      diagnostics.push({
        severity: "warning",
        message: `Unknown skillOverrides value ${JSON.stringify(value)} for skill "${skill.name}"; ignored`,
        source: skill.source.path,
      });
    }
    out.push(skill);
  }
  return out;
}

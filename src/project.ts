import os from "node:os";
import path from "node:path";
import type { ClaudeProject, Diagnostic, HookConfig } from "./types.js";
import { discoverArtifactDirs, resolveProjectRoot, dedupeByName } from "./discovery/locations.js";
import { loadSettings } from "./discovery/settings.js";
import { loadSkills } from "./claude/skills.js";
import { loadAgents } from "./claude/agents.js";
import { loadRules } from "./claude/rules.js";
import { loadClaudeMdHierarchy } from "./claude/claude-md.js";
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
}

export function loadClaudeProject(opts: {
  cwd: string;
  userDir?: string;
}): LoadedProject {
  const diagnostics: Diagnostic[] = [];
  const cwd = path.resolve(opts.cwd);
  const userDir = opts.userDir ?? path.join(os.homedir(), ".claude");
  const root = resolveProjectRoot(cwd);

  const settings = loadSettings({ cwd, projectRoot: root, userDir });
  const dirs = discoverArtifactDirs({ cwd, projectRoot: root, userDir });

  // Plugins: user-installed + project-bundled.
  const pluginResult = discoverInstalledPlugins({
    userDir,
    enabledPlugins: settings.enabledPlugins,
  });
  diagnostics.push(...pluginResult.diagnostics);
  const plugins = pluginResult.plugins.filter((p) => p.enabled);
  const bundled = discoverProjectBundledPlugin(root);
  if (bundled) plugins.push(bundled);
  const pluginRoots: Record<string, string> = {};
  for (const p of plugins) pluginRoots[p.name] = p.root;

  // Skills & commands (project/user scope first, then plugin content; first-wins dedupe).
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
    skills = dedupeByName([...skills, ...pluginSkills.skills]);
  }

  // Agents.
  const agentsResult = loadAgents(dirs.agentDirs);
  diagnostics.push(...agentsResult.diagnostics);
  let agents = agentsResult.agents;
  for (const plugin of plugins) {
    const pluginAgents = loadAgents(
      plugin.agentDirs.map((dir) => ({ dir, scope: "plugin" as const })),
      { pluginName: plugin.name },
    );
    diagnostics.push(...pluginAgents.diagnostics);
    agents = dedupeByName([...agents, ...pluginAgents.agents]);
  }

  // Rules.
  const rulesResult = loadRules(dirs.ruleDirs, {
    excludes: settings.claudeMdExcludes,
    projectRoot: root,
  });
  diagnostics.push(...rulesResult.diagnostics);

  // CLAUDE.md hierarchy.
  const claudeMdResult = loadClaudeMdHierarchy({
    cwd,
    projectRoot: root,
    userDir,
    excludes: settings.claudeMdExcludes,
  });
  diagnostics.push(...claudeMdResult.diagnostics);

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
  };
}

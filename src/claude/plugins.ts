/**
 * Installed-plugin content loading (plan §4.9).
 *
 * Discovers the user's *already-installed* plugins under `<userDir>/plugins`
 * and a project-bundled `.claude-plugin/` structure, and resolves the plugin
 * content directories (skills/agents/commands/hooks) so the respective
 * subsystems can fold them into their registries.
 *
 * Explicitly OUT of scope: plugin installation / marketplace machinery.
 * We never download, install, or register anything — if a plugin isn't on
 * disk, it doesn't exist for us.
 *
 * Layout tolerance: Claude Code has shipped several plugins-root layouts
 * (`plugins/repos/<owner>/<repo>/<name>/`, `plugins/cache/...`, flat dirs).
 * Rather than hard-coding one, we scan for any directory that contains
 * `.claude-plugin/plugin.json` (depth-capped).
 */

import path from "node:path";
import type { Diagnostic } from "../types.js";
import {
  isDirectory,
  isFile,
  listDirSafe,
  parseJsonSafe,
  readTextSafe,
} from "../util/fs.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface InstalledPlugin {
  name: string;
  /** Marketplace this plugin was cloned from (dir under `plugins/marketplaces/`), if any. */
  marketplace?: string;
  /** Plugin root directory (base for ${CLAUDE_PLUGIN_ROOT}). */
  root: string;
  /** Writable data directory (base for ${CLAUDE_PLUGIN_DATA}). */
  dataDir: string;
  /** Raw parsed plugin.json manifest ({} when missing/malformed). */
  manifest: Record<string, unknown>;
  /** Existing content directories only. */
  skillDirs: string[];
  agentDirs: string[];
  commandDirs: string[];
  /** Existing hooks config files (hooks/hooks.json + manifest-declared). */
  hooksFiles: string[];
  enabled: boolean;
  diagnostics: Diagnostic[];
}

/** Maximum directory depth below the plugins root when scanning for plugin manifests. */
const MAX_SCAN_DEPTH = 5;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Coerce a manifest content-path value (string | string[]) into a string list. */
function asPathList(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === "string");
  return [];
}

function pushUnique(list: string[], entry: string): void {
  if (!list.includes(entry)) list.push(entry);
}

/**
 * Resolve content dirs / hooks files for a plugin.
 *
 * Defaults (recorded only when they exist on disk):
 *   `<root>/skills`, `<root>/agents`, `<root>/commands`, `<root>/hooks/hooks.json`
 * plus any extra default bases (e.g. `<projectRoot>/.claude-plugin/...` for a
 * project-bundled plugin). The manifest may also point elsewhere via
 * `skills` / `agents` / `commands` / `hooks` keys holding relative paths.
 */
function resolveContent(
  root: string,
  manifest: Record<string, unknown>,
  extraBases: string[] = [],
): Pick<InstalledPlugin, "skillDirs" | "agentDirs" | "commandDirs" | "hooksFiles"> {
  const bases = [root, ...extraBases];

  const collectDirs = (kind: "skills" | "agents" | "commands"): string[] => {
    const dirs: string[] = [];
    // Manifest-declared locations take precedence when present.
    for (const rel of asPathList(manifest[kind])) {
      const abs = path.resolve(root, rel);
      if (isDirectory(abs)) pushUnique(dirs, abs);
    }
    if (dirs.length === 0) {
      for (const base of bases) {
        const abs = path.join(base, kind);
        if (isDirectory(abs)) pushUnique(dirs, abs);
      }
    }
    return dirs;
  };

  const hooksFiles: string[] = [];
  for (const rel of asPathList(manifest["hooks"])) {
    const abs = path.resolve(root, rel);
    if (isFile(abs)) pushUnique(hooksFiles, abs);
  }
  if (hooksFiles.length === 0) {
    for (const base of bases) {
      const abs = path.join(base, "hooks", "hooks.json");
      if (isFile(abs)) pushUnique(hooksFiles, abs);
    }
  }

  return {
    skillDirs: collectDirs("skills"),
    agentDirs: collectDirs("agents"),
    commandDirs: collectDirs("commands"),
    hooksFiles,
  };
}

/** The marketplace name for a plugin root under `plugins/marketplaces/<mp>/…`, else undefined. */
function marketplaceOf(root: string): string | undefined {
  const parts = root.split(/[\\/]+/);
  const idx = parts.lastIndexOf("marketplaces");
  if (idx >= 0 && idx + 1 < parts.length) return parts[idx + 1];
  return undefined;
}

/**
 * Resolve enabled state against the settings `enabledPlugins` value.
 *
 * Claude Code semantics (plan §4.9 — "from the enabled-plugins configuration"):
 * a plugin is loaded ONLY when it is **explicitly enabled**. A cloned
 * marketplace under `plugins/marketplaces/` is a *catalog* of available
 * plugins, not installed content — nothing there loads until the user enables
 * it. Therefore:
 * - object: enabled iff a candidate key (`name` or `name@marketplace`) is
 *   present with a truthy value; a matched-but-falsy value → disabled; no
 *   matching key → **disabled**.
 * - array: enabled iff a candidate key is a member.
 * - undefined / anything else: **disabled** (nothing enabled).
 */
function resolveEnabled(name: string, marketplace: string | undefined, enabledPlugins: unknown): boolean {
  const candidates = [name, ...(marketplace ? [`${name}@${marketplace}`] : [])];
  const isCandidate = (key: unknown): boolean =>
    typeof key === "string" &&
    (candidates.includes(key) || (marketplace === undefined && key.startsWith(`${name}@`)));

  if (Array.isArray(enabledPlugins)) {
    return enabledPlugins.some(isCandidate);
  }
  if (isPlainObject(enabledPlugins)) {
    return Object.entries(enabledPlugins).some(([key, value]) => isCandidate(key) && Boolean(value));
  }
  return false;
}

/**
 * Read `<pluginsRoot>/blocklist.json` into a set of blocked identifiers
 * (`name` and `name@marketplace` forms). Blocked plugins never load.
 */
function readBlocklist(pluginsRoot: string): Set<string> {
  const blocked = new Set<string>();
  const parsed = parseJsonSafe<{ plugins?: Array<{ plugin?: unknown }> }>(
    readTextSafe(path.join(pluginsRoot, "blocklist.json")),
  );
  for (const entry of parsed?.plugins ?? []) {
    if (typeof entry?.plugin === "string") blocked.add(entry.plugin);
  }
  return blocked;
}

function isBlocked(name: string, marketplace: string | undefined, blocked: Set<string>): boolean {
  if (blocked.has(name)) return true;
  if (marketplace && blocked.has(`${name}@${marketplace}`)) return true;
  return false;
}

/** Read + parse a plugin.json manifest. Returns undefined (with diagnostic) when malformed. */
function readManifest(
  manifestPath: string,
  diagnostics: Diagnostic[],
): Record<string, unknown> | undefined {
  const text = readTextSafe(manifestPath);
  if (text === undefined) {
    diagnostics.push({
      severity: "warning",
      message: `Plugin manifest is unreadable: ${manifestPath}`,
      source: manifestPath,
    });
    return undefined;
  }
  const parsed = parseJsonSafe(text);
  if (!isPlainObject(parsed)) {
    diagnostics.push({
      severity: "warning",
      message: `Plugin manifest is not valid JSON (skipping plugin): ${manifestPath}`,
      source: manifestPath,
    });
    return undefined;
  }
  return parsed;
}

/**
 * Depth-capped scan for plugin roots: any directory containing
 * `.claude-plugin/plugin.json`. Does not descend into found plugin roots,
 * `.claude-plugin` dirs, `node_modules`, `.git`, or the top-level `data` dir
 * (that's plugin data storage, not installed content).
 */
function scanPluginRoots(pluginsRoot: string): string[] {
  const roots: string[] = [];
  const visit = (dir: string, depth: number) => {
    for (const entry of listDirSafe(dir)) {
      if (!entry.isDirectory()) continue;
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      if (entry.name === ".claude-plugin") continue;
      if (depth === 0 && entry.name === "data") continue;
      const full = path.join(dir, entry.name);
      if (isFile(path.join(full, ".claude-plugin", "plugin.json"))) {
        roots.push(full);
        continue; // do not descend into a plugin root
      }
      if (depth + 1 < MAX_SCAN_DEPTH) visit(full, depth + 1);
    }
  };
  visit(pluginsRoot, 0);
  return roots.sort();
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Discover installed plugins under `<userDir>/plugins`.
 * Never throws (completeness floor); problems become diagnostics.
 */
export function discoverInstalledPlugins(opts: {
  userDir: string;
  enabledPlugins: unknown;
}): { plugins: InstalledPlugin[]; diagnostics: Diagnostic[] } {
  const diagnostics: Diagnostic[] = [];
  const plugins: InstalledPlugin[] = [];
  const pluginsRoot = path.join(opts.userDir, "plugins");
  if (!isDirectory(pluginsRoot)) {
    return { plugins, diagnostics };
  }
  const blocked = readBlocklist(pluginsRoot);

  for (const root of scanPluginRoots(pluginsRoot)) {
    const manifestPath = path.join(root, ".claude-plugin", "plugin.json");
    const pluginDiagnostics: Diagnostic[] = [];
    const manifest = readManifest(manifestPath, pluginDiagnostics);
    if (manifest === undefined) {
      diagnostics.push(...pluginDiagnostics);
      continue; // malformed manifest → skip plugin (diagnostic already recorded)
    }

    const name =
      typeof manifest["name"] === "string" && manifest["name"].length > 0
        ? manifest["name"]
        : path.basename(root);
    const marketplace = marketplaceOf(root);
    const enabled =
      !isBlocked(name, marketplace, blocked) &&
      resolveEnabled(name, marketplace, opts.enabledPlugins);

    plugins.push({
      name,
      marketplace,
      root,
      dataDir: path.join(pluginsRoot, "data", name),
      manifest,
      ...resolveContent(root, manifest),
      enabled,
      diagnostics: pluginDiagnostics,
    });
  }

  // Help the user understand why plugin content is (not) loading: a cloned
  // marketplace surfaces many plugins, but only explicitly-enabled ones load.
  const enabledCount = plugins.filter((p) => p.enabled).length;
  if (plugins.length > 0 && enabledCount === 0) {
    diagnostics.push({
      severity: "info",
      message:
        `${plugins.length} plugin(s) available under ~/.claude/plugins but none are enabled — ` +
        `enable specific ones in Claude Code (settings "enabledPlugins") to load their skills/agents/commands.`,
    });
  }

  return { plugins, diagnostics };
}

/**
 * Discover a project-bundled plugin: `.claude-plugin/` at the project root
 * containing `plugin.json`. Content dirs may live at
 * `<projectRoot>/.claude-plugin/skills` (etc.) or at `<projectRoot>/skills`,
 * or the manifest may point elsewhere via `skills`/`agents`/`commands` keys
 * with projectRoot-relative paths. Returns undefined when there is no
 * `.claude-plugin/` directory. Never throws.
 */
export function discoverProjectBundledPlugin(
  projectRoot: string,
): InstalledPlugin | undefined {
  const bundleDir = path.join(projectRoot, ".claude-plugin");
  if (!isDirectory(bundleDir)) return undefined;

  const diagnostics: Diagnostic[] = [];
  const manifestPath = path.join(bundleDir, "plugin.json");
  let manifest: Record<string, unknown> = {};
  if (isFile(manifestPath)) {
    manifest = readManifest(manifestPath, diagnostics) ?? {};
  } else {
    diagnostics.push({
      severity: "warning",
      message: `Project-bundled plugin has no plugin.json manifest: ${bundleDir}`,
      source: bundleDir,
    });
  }

  const name =
    typeof manifest["name"] === "string" && manifest["name"].length > 0
      ? manifest["name"]
      : path.basename(projectRoot);

  return {
    name,
    root: projectRoot,
    dataDir: path.join(bundleDir, "data"),
    manifest,
    ...resolveContent(projectRoot, manifest, [bundleDir]),
    enabled: true,
    diagnostics,
  };
}

/** Replace ${CLAUDE_PLUGIN_ROOT} / ${CLAUDE_PLUGIN_DATA} in a text. */
export function expandPluginVariables(text: string, plugin: InstalledPlugin): string {
  return text
    .split("${CLAUDE_PLUGIN_ROOT}")
    .join(plugin.root)
    .split("${CLAUDE_PLUGIN_DATA}")
    .join(plugin.dataDir);
}

/** Deep-walk a parsed JSON value, expanding plugin variables in every string. */
function expandDeep(value: unknown, plugin: InstalledPlugin): unknown {
  if (typeof value === "string") return expandPluginVariables(value, plugin);
  if (Array.isArray(value)) return value.map((v) => expandDeep(v, plugin));
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = expandDeep(v, plugin);
    return out;
  }
  return value;
}

/**
 * Read and merge a plugin's hooks config files, expanding plugin variables in
 * all string values. Returns the *raw* merged object — the hooks subsystem
 * parses it further via its own parseHookConfig. Never throws.
 */
export function loadPluginHooks(plugin: InstalledPlugin): {
  config: Record<string, unknown>;
  diagnostics: Diagnostic[];
} {
  const diagnostics: Diagnostic[] = [];
  const config: Record<string, unknown> = {};

  for (const file of plugin.hooksFiles) {
    const parsed = parseJsonSafe(readTextSafe(file));
    if (!isPlainObject(parsed)) {
      diagnostics.push({
        severity: "warning",
        message: `Plugin hooks file is not a valid JSON object (ignored): ${file}`,
        source: file,
      });
      continue;
    }
    // Some plugins wrap the event map in a top-level "hooks" key; unwrap it.
    const eventMap = isPlainObject(parsed["hooks"]) ? parsed["hooks"] : parsed;
    const expanded = expandDeep(eventMap, plugin) as Record<string, unknown>;
    for (const [event, entries] of Object.entries(expanded)) {
      const existing = config[event];
      if (Array.isArray(existing) && Array.isArray(entries)) {
        config[event] = [...existing, ...entries];
      } else {
        config[event] = entries;
      }
    }
  }

  return { config, diagnostics };
}

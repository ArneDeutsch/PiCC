import fs from "node:fs";
import path from "node:path";
import type {
  Diagnostic,
  EffectivePluginEnablement,
  NormalizedPluginInstallation,
  PluginComponentSource,
  PluginInstallationScope,
  PluginResolutionOutcome,
  PluginRuntimeContext,
  PluginSharedStateCause,
} from "../types.js";
import { parseJsonSafe, readTextSafe } from "../util/fs.js";
import { isQualifiedPluginId } from "../util/plugin-id.js";
import type { PluginAgentLoaderSource } from "./agents.js";
import { projectPluginManifest, type SafePluginManifestProjection } from "./plugin-metadata.js";
import {
  authorizePluginRoot,
  resolvePluginDataLocation,
  resolvePluginPath,
  revalidatePluginPath,
  type AuthorizedPluginRoot,
  type ValidatedPluginPath,
} from "./plugin-paths.js";
import type { PluginSkillLoaderSource } from "./skills.js";

const COMPONENT_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SCOPE_RANK: Readonly<Record<PluginInstallationScope, number>> = {
  user: 0,
  project: 1,
  local: 2,
  managed: 3,
};

export interface InstalledPlugin {
  pluginId: string;
  name: string;
  marketplace: string;
  version: string;
  scope: PluginInstallationScope;
  projectPath?: string;
  root: string;
  dataDir: string;
  manifestProjection: SafePluginManifestProjection;
  skillSources: PluginSkillLoaderSource[];
  commandSources: PluginSkillLoaderSource[];
  agentSources: PluginAgentLoaderSource[];
  hookSources: PluginComponentSource[];
  hookPathSources: Array<{ source: Exclude<PluginComponentSource, { kind: "inline" }>; validatedPath: ValidatedPluginPath }>;
  enabled: true;
  diagnostics: Diagnostic[];
  installation: NormalizedPluginInstallation;
  context: PluginRuntimeContext;
}

export interface ResolveInstalledPluginsResult {
  plugins: InstalledPlugin[];
  outcomes: PluginResolutionOutcome[];
  diagnostics: Diagnostic[];
}

interface ProvisionalPlugin {
  plugin: InstalledPlugin;
  outcome: PluginResolutionOutcome;
  dataCollisionToken: string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function diagnostic(pluginId: string, message: string): Diagnostic {
  return {
    severity: "warning",
    message: `Installed plugin "${pluginId.length <= 128 ? pluginId : "qualified identity"}" ${message}`,
  };
}

function identityOf(pluginId: string): { name: string; marketplace: string } {
  const split = pluginId.lastIndexOf("@");
  return { name: pluginId.slice(0, split), marketplace: pluginId.slice(split + 1) };
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalDirectory(value: string): string | undefined {
  try {
    const canonical = fs.realpathSync.native(value);
    return fs.statSync(canonical).isDirectory() ? canonical : undefined;
  } catch {
    return undefined;
  }
}

function sameFilesystemIdentity(left: string | undefined, right: string | undefined): boolean {
  if (left === right) return true;
  if (left === undefined || right === undefined) return false;
  const leftCanonical = canonicalDirectory(left);
  const rightCanonical = canonicalDirectory(right);
  return leftCanonical !== undefined && rightCanonical !== undefined && leftCanonical === rightCanonical;
}

function effectiveProjectPath(record: NormalizedPluginInstallation): string | undefined {
  return record.scope === "project" || record.scope === "local" ? record.projectPath : undefined;
}

function equivalentInstallation(left: NormalizedPluginInstallation, right: NormalizedPluginInstallation): boolean {
  return left.pluginId === right.pluginId && left.scope === right.scope && left.version === right.version &&
    sameFilesystemIdentity(effectiveProjectPath(left), effectiveProjectPath(right)) &&
    sameFilesystemIdentity(left.installPath, right.installPath);
}

function compareInstallations(left: NormalizedPluginInstallation, right: NormalizedPluginInstallation): number {
  for (const [leftValue, rightValue] of [
    [left.installPath, right.installPath],
    [left.projectPath ?? "", right.projectPath ?? ""],
    [left.version, right.version],
    [left.provenance.statePath, right.provenance.statePath],
    [left.provenance.installedAt ?? "", right.provenance.installedAt ?? ""],
    [left.provenance.lastUpdated ?? "", right.provenance.lastUpdated ?? ""],
  ] as const) {
    const compared = compareText(leftValue, rightValue);
    if (compared !== 0) return compared;
  }
  return 0;
}

function isContained(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

function structurallyValidCommonGitDirectory(gitDirectory: string): boolean {
  try {
    return path.basename(gitDirectory) === ".git" && fs.statSync(path.join(gitDirectory, "HEAD")).isFile() &&
      fs.statSync(path.join(gitDirectory, "config")).isFile() && fs.statSync(path.join(gitDirectory, "objects")).isDirectory() &&
      fs.statSync(path.join(gitDirectory, "refs")).isDirectory();
  } catch {
    return false;
  }
}

/** Canonicalize the project root; derive a distinct main checkout only from linked Git administration data. */
export function resolvePluginProjectAnchors(projectRoot: string): { projectRoot?: string; mainCheckout?: string } {
  const canonicalProject = canonicalDirectory(projectRoot);
  if (canonicalProject === undefined) return {};
  const dotGit = path.join(canonicalProject, ".git");
  try {
    if (fs.statSync(dotGit).isDirectory()) {
      const common = fs.realpathSync.native(dotGit);
      return structurallyValidCommonGitDirectory(common) ? { projectRoot: canonicalProject, mainCheckout: canonicalProject } : { projectRoot: canonicalProject };
    }
    if (!fs.statSync(dotGit).isFile()) return { projectRoot: canonicalProject };
    const match = /^gitdir:\s*(.+)$/i.exec(fs.readFileSync(dotGit, "utf8").trim());
    if (match === null) return { projectRoot: canonicalProject };
    const admin = canonicalDirectory(path.resolve(canonicalProject, match[1]!));
    if (admin === undefined || path.basename(path.dirname(admin)) !== "worktrees") return { projectRoot: canonicalProject };
    const backlink = fs.readFileSync(path.join(admin, "gitdir"), "utf8").trim();
    if (path.basename(backlink) !== ".git" || fs.realpathSync.native(path.dirname(backlink)) !== canonicalProject) return { projectRoot: canonicalProject };
    const common = fs.realpathSync.native(path.resolve(admin, fs.readFileSync(path.join(admin, "commondir"), "utf8").trim()));
    if (!structurallyValidCommonGitDirectory(common)) return { projectRoot: canonicalProject };
    const worktrees = fs.realpathSync.native(path.join(common, "worktrees"));
    if (fs.realpathSync.native(path.dirname(admin)) !== worktrees) return { projectRoot: canonicalProject };
    const main = fs.realpathSync.native(path.dirname(common));
    return fs.realpathSync.native(path.join(main, ".git")) === common
      ? { projectRoot: canonicalProject, mainCheckout: main }
      : { projectRoot: canonicalProject };
  } catch {
    return { projectRoot: canonicalProject };
  }
}

function projectIdentities(projectRoot: string): Set<string> {
  const anchors = resolvePluginProjectAnchors(projectRoot);
  return new Set([anchors.projectRoot, anchors.mainCheckout].filter((value): value is string => value !== undefined));
}

function applicable(record: NormalizedPluginInstallation, projects: ReadonlySet<string>): boolean {
  if (record.scope === "user" || record.scope === "managed") return true;
  if (!record.projectPath || !path.isAbsolute(record.projectPath)) return false;
  const canonical = canonicalDirectory(record.projectPath);
  return canonical !== undefined && projects.has(canonical);
}

function chooseInstallation(
  pluginId: string,
  installations: readonly NormalizedPluginInstallation[],
  projects: ReadonlySet<string>,
): { installation?: NormalizedPluginInstallation; ambiguous: boolean } {
  const applicableRecords = installations.filter((record) => record.pluginId === pluginId && applicable(record, projects));
  if (applicableRecords.length === 0) return { ambiguous: false };
  const winnerRank = Math.max(...applicableRecords.map((record) => SCOPE_RANK[record.scope]));
  const winners = applicableRecords
    .filter((record) => SCOPE_RANK[record.scope] === winnerRank)
    .sort(compareInstallations);
  const first = winners[0]!;
  return winners.every((record) => equivalentInstallation(first, record))
    ? { installation: first, ambiguous: false }
    : { ambiguous: true };
}

function readBlocklist(
  userDir: string,
  reader: (file: string) => string = (file) => fs.readFileSync(file, "utf8"),
): { blocked: Set<string>; status: "absent" | "valid" | "malformed" | "unreadable"; diagnostic?: Diagnostic } {
  const file = path.join(userDir, "plugins", "blocklist.json");
  let text: string;
  try {
    text = reader(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return { blocked: new Set(), status: "absent" };
    return {
      blocked: new Set(),
      status: "unreadable",
      diagnostic: { severity: "warning", message: "Plugin blocklist is unreadable; all enabled plugins were rejected", source: file },
    };
  }
  const parsed = parseJsonSafe(text);
  if (!isPlainObject(parsed) || (parsed["plugins"] !== undefined && !Array.isArray(parsed["plugins"]))) {
    return {
      blocked: new Set(),
      status: "malformed",
      diagnostic: { severity: "warning", message: "Plugin blocklist is malformed; all enabled plugins were rejected", source: file },
    };
  }
  const blocked = new Set<string>();
  for (const entry of (parsed["plugins"] ?? []) as unknown[]) {
    if (!isPlainObject(entry) || typeof entry["plugin"] !== "string" || !isQualifiedPluginId(entry["plugin"])) {
      return {
        blocked: new Set(),
        status: "malformed",
        diagnostic: { severity: "warning", message: "Plugin blocklist is malformed; all enabled plugins were rejected", source: file },
      };
    }
    blocked.add(entry["plugin"]);
  }
  return { blocked, status: "valid" };
}

export function authorizedCacheRoots(userDir: string, env: NodeJS.ProcessEnv): string[] {
  const candidates = [path.join(userDir, "plugins", "cache")];
  if (env["CLAUDE_CODE_PLUGIN_CACHE_DIR"]) candidates.push(env["CLAUDE_CODE_PLUGIN_CACHE_DIR"]);
  for (const seed of (env["CLAUDE_CODE_PLUGIN_SEED_DIR"] ?? "").split(path.delimiter)) {
    if (seed) candidates.push(path.join(seed, "cache"));
  }
  const canonical = candidates.map(canonicalDirectory).filter((value): value is string => value !== undefined);
  return [...new Set(canonical)].sort(compareText);
}

function authorizeInstallationRoot(
  installation: NormalizedPluginInstallation,
  cacheRoots: readonly string[],
): ReturnType<typeof authorizePluginRoot> {
  const root = authorizePluginRoot(installation.installPath);
  if (!root.ok) return root;
  const cacheRoot = cacheRoots.find((candidate) => isContained(candidate, root.value.canonicalPath) && root.value.canonicalPath !== candidate);
  if (!cacheRoot) {
    return {
      ok: false,
      code: "path-escape",
      diagnostic: { severity: "warning", message: "Installed plugin root is outside every authorized plugin cache" },
    };
  }
  const identity = identityOf(installation.pluginId);
  const relative = path.relative(cacheRoot, root.value.canonicalPath).split(path.sep);
  const expected = [identity.marketplace, identity.name, installation.version];
  const actual = relative.slice(-3);
  const normalize = (value: string): string => process.platform === "win32" ? value.toLowerCase() : value;
  if (relative.length !== 3 || actual.some((value, index) => normalize(value) !== normalize(expected[index]!))) {
    return {
      ok: false,
      code: "invalid-path",
      diagnostic: { severity: "warning", message: "Installed plugin root layout does not match its qualified identity and version" },
    };
  }
  return root;
}

function sourceFor(pluginId: string, pluginName: string, validatedPath: ValidatedPluginPath): PluginComponentSource {
  const metadata = {
    pluginId,
    pluginName,
    authorizedRoot: validatedPath.root.canonicalPath,
    lexicalPath: validatedPath.lexicalPath,
    canonicalPath: validatedPath.canonicalPath,
  };
  return validatedPath.kind === "file"
    ? { kind: "file", path: validatedPath.lexicalPath, metadata }
    : { kind: "directory", path: validatedPath.lexicalPath, metadata };
}

function resolveExistingGenerated(
  root: AuthorizedPluginRoot,
  relative: string,
  kind: "file" | "directory" | "either",
): { state: "absent" } | { state: "failure"; diagnostic: Diagnostic } | { state: "ok"; value: ValidatedPluginPath } {
  const lexical = path.join(root.lexicalPath, ...relative.split("/"));
  try {
    fs.lstatSync(lexical);
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return { state: "absent" };
    return { state: "failure", diagnostic: { severity: "warning", message: "Plugin component path is unreadable" } };
  }
  const result = resolvePluginPath({ root, declaredPath: relative, inputKind: "generated", kind });
  return result.ok ? { state: "ok", value: result.value } : { state: "failure", diagnostic: result.diagnostic };
}

function declaredPaths(value: unknown): string[] | undefined {
  if (typeof value === "string") return [value];
  if (Array.isArray(value) && value.every((entry) => typeof entry === "string")) return value as string[];
  return undefined;
}

type ManifestComponentField = "skills" | "commands" | "agents" | "hooks";

function declarationDiagnostic(field: ManifestComponentField, reason: string): Diagnostic {
  return { severity: "warning", message: `Plugin manifest ${field} declaration ${reason}` };
}

function resolveDeclaredSources(options: {
  root: AuthorizedPluginRoot;
  pluginId: string;
  pluginName: string;
  field: ManifestComponentField;
  value: unknown;
  kind: "file" | "directory" | "either";
  fileExtension?: ".md" | ".json";
}): { sources: Array<{ source: PluginComponentSource; validatedPath: ValidatedPluginPath }>; diagnostics: Diagnostic[] } {
  const diagnostics: Diagnostic[] = [];
  const sources: Array<{ source: PluginComponentSource; validatedPath: ValidatedPluginPath }> = [];
  const paths = declaredPaths(options.value);
  if (!paths) return { sources, diagnostics: [declarationDiagnostic(options.field, "has the wrong type")] };
  for (const declaredPath of paths) {
    const result = resolvePluginPath({ root: options.root, declaredPath, inputKind: "explicit", kind: options.kind });
    if (!result.ok) {
      diagnostics.push(declarationDiagnostic(options.field, `has an invalid path (${result.code})`));
    } else if (
      result.value.kind === "file" && options.fileExtension !== undefined &&
      path.extname(result.value.lexicalPath).toLowerCase() !== options.fileExtension
    ) {
      diagnostics.push(declarationDiagnostic(options.field, `uses a file with the wrong extension (expected ${options.fileExtension})`));
    } else {
      sources.push({ source: sourceFor(options.pluginId, options.pluginName, result.value), validatedPath: result.value });
    }
  }
  return { sources, diagnostics };
}

function readManifest(root: AuthorizedPluginRoot):
  | { ok: true; manifest: Record<string, unknown>; manifestPath?: ValidatedPluginPath }
  | { ok: false; diagnostic: Diagnostic } {
  const candidate = resolveExistingGenerated(root, ".claude-plugin/plugin.json", "file");
  if (candidate.state === "absent") return { ok: true, manifest: {} };
  if (candidate.state === "failure") return { ok: false, diagnostic: candidate.diagnostic };
  const current = revalidatePluginPath(candidate.value);
  if (!current.ok) return { ok: false, diagnostic: current.diagnostic };
  const parsed = parseJsonSafe(readTextSafe(current.value.lexicalPath));
  if (!isPlainObject(parsed)) return { ok: false, diagnostic: { severity: "warning", message: "Plugin manifest is unreadable or malformed" } };
  if (typeof parsed["name"] !== "string" || !COMPONENT_NAME.test(parsed["name"])) {
    return {
      ok: false,
      diagnostic: {
        severity: "warning",
        message: "Plugin manifest name is malformed; expected lowercase letters or digits separated by single hyphens",
      },
    };
  }
  return { ok: true, manifest: parsed, manifestPath: current.value };
}

function resolveComponents(options: {
  root: AuthorizedPluginRoot;
  pluginId: string;
  lifecycleName: string;
  marketplace: string;
  version: string;
  scope: PluginInstallationScope;
  projectPath?: string;
  installation: NormalizedPluginInstallation;
  userDir: string;
  projectRoot: string;
}): { ok: true; plugin: InstalledPlugin; dataCollisionToken: string } | { ok: false; diagnostics: Diagnostic[] } {
  const manifestResult = readManifest(options.root);
  if (!manifestResult.ok) return { ok: false, diagnostics: [manifestResult.diagnostic] };
  const manifest = manifestResult.manifest;
  const projectedManifest = projectPluginManifest(manifest);
  const pluginName = manifestResult.manifestPath ? manifest["name"] as string : options.lifecycleName;
  if (!COMPONENT_NAME.test(pluginName)) return {
    ok: false,
    diagnostics: [{
      severity: "warning",
      message: "Plugin component namespace is malformed; expected lowercase letters or digits separated by single hyphens",
    }],
  };

  const data = resolvePluginDataLocation(options.userDir, options.pluginId);
  if (!data.ok) return { ok: false, diagnostics: [data.diagnostic] };
  const context: PluginRuntimeContext = {
    pluginId: options.pluginId,
    pluginName,
    root: options.root.canonicalPath,
    dataDir: data.value.lexicalPath,
    projectDir: options.projectRoot,
  };
  const skillSources: PluginSkillLoaderSource[] = [];
  const commandSources: PluginSkillLoaderSource[] = [];
  const agentSources: PluginAgentLoaderSource[] = [];
  const hookSources: PluginComponentSource[] = [];
  const hookPathSources: Array<{ source: Exclude<PluginComponentSource, { kind: "inline" }>; validatedPath: ValidatedPluginPath }> = [];
  const terminalDiagnostics: Diagnostic[] = [];

  const addGenerated = (
    relative: string,
    kind: "file" | "directory",
    target: PluginSkillLoaderSource[] | PluginAgentLoaderSource[] | undefined,
  ): boolean => {
    const result = resolveExistingGenerated(options.root, relative, kind);
    if (result.state === "absent") return false;
    if (result.state === "failure") terminalDiagnostics.push(result.diagnostic);
    else {
      const source = sourceFor(options.pluginId, pluginName, result.value);
      if (target) target.push({ source: source as Exclude<PluginComponentSource, { kind: "inline" }>, validatedPath: result.value });
      else {
        const fileSource = source as Exclude<PluginComponentSource, { kind: "inline" }>;
        hookSources.push(fileSource);
        hookPathSources.push({ source: fileSource, validatedPath: result.value });
      }
    }
    return true;
  };
  const addDeclared = (
    field: "skills" | "commands" | "agents",
    target: PluginSkillLoaderSource[] | PluginAgentLoaderSource[],
  ): void => {
    const resolved = resolveDeclaredSources({
      root: options.root,
      pluginId: options.pluginId,
      pluginName,
      field,
      value: manifest[field],
      kind: field === "skills" ? "directory" : "either",
      ...(field === "skills" ? {} : { fileExtension: ".md" as const }),
    });
    terminalDiagnostics.push(...resolved.diagnostics);
    for (const entry of resolved.sources) target.push({ source: entry.source as Exclude<PluginComponentSource, { kind: "inline" }>, validatedPath: entry.validatedPath });
  };

  const hasSkillsDir = addGenerated("skills", "directory", skillSources);
  if (Object.hasOwn(manifest, "skills")) addDeclared("skills", skillSources);
  else if (!hasSkillsDir) addGenerated("SKILL.md", "file", skillSources);

  if (Object.hasOwn(manifest, "commands")) addDeclared("commands", commandSources);
  else addGenerated("commands", "directory", commandSources);
  if (Object.hasOwn(manifest, "agents")) addDeclared("agents", agentSources);
  else addGenerated("agents", "directory", agentSources);

  addGenerated("hooks/hooks.json", "file", undefined);
  if (Object.hasOwn(manifest, "hooks")) {
    const hooks = manifest["hooks"];
    const contributions = Array.isArray(hooks) ? hooks : [hooks];
    for (const contribution of contributions) {
      if (typeof contribution === "string") {
        const resolved = resolveDeclaredSources({
          root: options.root,
          pluginId: options.pluginId,
          pluginName,
          field: "hooks",
          value: contribution,
          kind: "file",
          fileExtension: ".json",
        });
        terminalDiagnostics.push(...resolved.diagnostics);
        for (const entry of resolved.sources) {
          const fileSource = entry.source as Exclude<PluginComponentSource, { kind: "inline" }>;
          hookSources.push(fileSource);
          hookPathSources.push({ source: fileSource, validatedPath: entry.validatedPath });
        }
      } else if (isPlainObject(contribution)) {
        hookSources.push({ kind: "inline", value: contribution, pluginId: options.pluginId, pluginName, source: "plugin manifest hooks" });
      } else {
        terminalDiagnostics.push(declarationDiagnostic("hooks", "has the wrong type"));
      }
    }
  }
  if (terminalDiagnostics.length > 0) return { ok: false, diagnostics: terminalDiagnostics.slice(0, 20) };

  const diagnostics: Diagnostic[] = projectedManifest.diagnostics;
  const plugin: InstalledPlugin = {
    pluginId: options.pluginId,
    name: pluginName,
    marketplace: options.marketplace,
    version: options.version,
    scope: options.scope,
    ...(options.projectPath === undefined ? {} : { projectPath: options.projectPath }),
    root: options.root.canonicalPath,
    dataDir: data.value.lexicalPath,
    manifestProjection: projectedManifest.projection,
    skillSources,
    commandSources,
    agentSources,
    hookSources,
    hookPathSources,
    enabled: true,
    diagnostics,
    installation: options.installation,
    context,
  };
  return { ok: true, plugin, dataCollisionToken: data.value.collisionToken };
}

export function resolveInstalledPlugins(options: {
  userDir: string;
  projectRoot: string;
  enablement: Readonly<Record<string, EffectivePluginEnablement>>;
  installations: readonly NormalizedPluginInstallation[];
  installedStateStatus: "absent" | "valid" | "unreadable" | "unsupported" | "malformed";
  env?: NodeJS.ProcessEnv;
  readBlocklistForTest?: (file: string) => string;
}): ResolveInstalledPluginsResult {
  const outcomes: PluginResolutionOutcome[] = [];
  const diagnostics: Diagnostic[] = [];
  const provisional: ProvisionalPlugin[] = [];
  const projects = projectIdentities(options.projectRoot);
  const cacheRoots = authorizedCacheRoots(options.userDir, options.env ?? process.env);
  const blocklist = readBlocklist(options.userDir, options.readBlocklistForTest);
  if (blocklist.diagnostic) diagnostics.push(blocklist.diagnostic);

  for (const pluginId of Object.keys(options.enablement).sort(compareText)) {
    const enabled = options.enablement[pluginId]!;
    if (!enabled.enabled) {
      outcomes.push({ pluginId, status: "disabled", diagnostics: [] });
      continue;
    }
    const sharedStateCauses: PluginSharedStateCause[] = [];
    if (options.installedStateStatus === "unsupported") sharedStateCauses.push("installed-state-unsupported");
    else if (options.installedStateStatus === "malformed") sharedStateCauses.push("installed-state-malformed");
    else if (options.installedStateStatus === "unreadable") sharedStateCauses.push("installed-state-unreadable");
    if (blocklist.status === "malformed") sharedStateCauses.push("blocklist-malformed");
    else if (blocklist.status === "unreadable") sharedStateCauses.push("blocklist-unreadable");

    if (blocklist.status === "malformed" || blocklist.status === "unreadable") {
      outcomes.push({
        pluginId,
        status: blocklist.status === "malformed" ? "malformed" : "rejected",
        sharedStateCauses,
        diagnostics: [],
      });
      continue;
    }
    if (blocklist.blocked.has(pluginId)) {
      const item = diagnostic(pluginId, "is denied by the qualified blocklist");
      outcomes.push({ pluginId, status: "blocked", diagnostics: [item] });
      diagnostics.push(item);
      continue;
    }
    if (options.installedStateStatus !== "valid") {
      const status = options.installedStateStatus === "unsupported" ? "unsupported"
        : options.installedStateStatus === "malformed" ? "malformed"
        : options.installedStateStatus === "absent" ? "enabled-but-uninstalled" : "rejected";
      outcomes.push({ pluginId, status, ...(sharedStateCauses.length > 0 ? { sharedStateCauses } : {}), diagnostics: [] });
      continue;
    }
    const selected = chooseInstallation(pluginId, options.installations, projects);
    if (selected.ambiguous) {
      const item = diagnostic(pluginId, "has conflicting highest-scope installation records; nothing was loaded");
      outcomes.push({ pluginId, status: "ambiguous", diagnostics: [item] });
      diagnostics.push(item);
      continue;
    }
    if (!selected.installation) {
      outcomes.push({ pluginId, status: "enabled-but-uninstalled", diagnostics: [] });
      continue;
    }
    const root = authorizeInstallationRoot(selected.installation, cacheRoots);
    if (!root.ok) {
      const reason = { severity: "warning" as const, message: root.diagnostic.message };
      const item = diagnostic(pluginId, "has an unauthorized or invalid installed root; nothing was loaded");
      outcomes.push({ pluginId, status: "rejected", installation: selected.installation, diagnostics: [reason, item] });
      diagnostics.push(reason, item);
      continue;
    }
    const identity = identityOf(pluginId);
    const resolved = resolveComponents({
      root: root.value,
      pluginId,
      lifecycleName: identity.name,
      marketplace: identity.marketplace,
      version: selected.installation.version,
      scope: selected.installation.scope,
      ...(selected.installation.projectPath === undefined ? {} : { projectPath: selected.installation.projectPath }),
      installation: selected.installation,
      userDir: options.userDir,
      projectRoot: options.projectRoot,
    });
    if (!resolved.ok) {
      const item = diagnostic(pluginId, "has invalid manifest or component declarations; nothing was loaded");
      const pluginDiagnostics = [item, ...resolved.diagnostics].slice(0, 20);
      outcomes.push({ pluginId, status: "rejected", installation: selected.installation, diagnostics: pluginDiagnostics });
      diagnostics.push(...pluginDiagnostics);
      continue;
    }
    const outcome: PluginResolutionOutcome = {
      pluginId,
      status: "loaded",
      installation: selected.installation,
      context: resolved.plugin.context,
      sources: [
        ...resolved.plugin.skillSources.map((entry) => entry.source),
        ...resolved.plugin.commandSources.map((entry) => entry.source),
        ...resolved.plugin.agentSources.map((entry) => entry.source),
        ...resolved.plugin.hookSources,
      ],
      diagnostics: resolved.plugin.diagnostics,
    };
    provisional.push({ plugin: resolved.plugin, outcome, dataCollisionToken: resolved.dataCollisionToken });
  }

  const rejectedIds = new Set<string>();
  const namespaceGroups = new Map<string, ProvisionalPlugin[]>();
  const dataGroups = new Map<string, ProvisionalPlugin[]>();
  for (const item of provisional) {
    (namespaceGroups.get(item.plugin.name) ?? namespaceGroups.set(item.plugin.name, []).get(item.plugin.name)!).push(item);
    (dataGroups.get(item.dataCollisionToken) ?? dataGroups.set(item.dataCollisionToken, []).get(item.dataCollisionToken)!).push(item);
  }
  for (const groups of [namespaceGroups, dataGroups]) {
    for (const items of groups.values()) if (items.length > 1) for (const item of items) rejectedIds.add(item.plugin.pluginId);
  }
  for (const item of provisional) {
    if (!rejectedIds.has(item.plugin.pluginId)) {
      outcomes.push(item.outcome);
      continue;
    }
    const collisionDiagnostics: Diagnostic[] = [];
    if ((namespaceGroups.get(item.plugin.name)?.length ?? 0) > 1) {
      collisionDiagnostics.push(diagnostic(item.plugin.pluginId, "has a component namespace collision; conflicting content was rejected"));
    }
    if ((dataGroups.get(item.dataCollisionToken)?.length ?? 0) > 1) {
      collisionDiagnostics.push(diagnostic(item.plugin.pluginId, "has a persistent data key collision; conflicting content was rejected"));
    }
    outcomes.push({
      ...item.outcome,
      status: "rejected",
      context: undefined,
      sources: undefined,
      diagnostics: [...item.outcome.diagnostics.slice(0, 20 - collisionDiagnostics.length), ...collisionDiagnostics],
    });
    diagnostics.push(...collisionDiagnostics);
  }

  outcomes.sort((left, right) => compareText(left.pluginId, right.pluginId));
  return {
    plugins: provisional.filter((item) => !rejectedIds.has(item.plugin.pluginId)).map((item) => item.plugin),
    outcomes,
    diagnostics,
  };
}

export function loadPluginHooks(plugin: InstalledPlugin): {
  config: Record<string, unknown>;
  diagnostics: Diagnostic[];
  rejected: boolean;
  rejectionDiagnostics: Diagnostic[];
} {
  const config: Record<string, unknown> = {};
  const diagnostics: Diagnostic[] = [];
  const rejectionDiagnostics: Diagnostic[] = [];
  let rejected = false;
  const reject = (diagnostic: Diagnostic): void => {
    diagnostics.push(diagnostic);
    rejectionDiagnostics.push(diagnostic);
    rejected = true;
  };
  for (const source of plugin.hookSources ?? []) {
    let parsed: unknown;
    if (source.kind === "inline") parsed = source.value;
    else {
      const validated = plugin.hookPathSources.find((entry) => entry.source === source)?.validatedPath;
      if (!validated) {
        reject({ severity: "warning", message: "Plugin hook source no longer matches its validated path" });
        continue;
      }
      const current = revalidatePluginPath(validated);
      if (!current.ok) {
        reject(current.diagnostic);
        continue;
      }
      const raw = readTextSafe(current.value.lexicalPath);
      if (raw === undefined) {
        reject({ severity: "warning", message: "Plugin hook source became unreadable after validation" });
        continue;
      }
      parsed = parseJsonSafe(raw);
    }
    if (!isPlainObject(parsed)) {
      diagnostics.push({ severity: "warning", message: "Plugin hooks contribution is not a valid object" });
      continue;
    }
    const eventMap = isPlainObject(parsed["hooks"]) ? parsed["hooks"] : parsed;
    for (const [event, entries] of Object.entries(eventMap)) {
      if (event in Object.prototype) {
        diagnostics.push({ severity: "warning", message: "Unsafe plugin hook event key was ignored" });
        continue;
      }
      if (!Array.isArray(entries)) {
        diagnostics.push({
          severity: "warning",
          message: "Plugin hook event contribution must be an array and was ignored",
        });
        continue;
      }
      const existing = Object.hasOwn(config, event) ? config[event] : undefined;
      config[event] = [...(Array.isArray(existing) ? existing : []), ...entries];
    }
  }
  return { config, diagnostics, rejected, rejectionDiagnostics };
}

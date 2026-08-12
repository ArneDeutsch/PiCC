import os from "node:os";
import path from "node:path";
import type { ClaudeProject, ClaudeSkill, Diagnostic, HookConfig, HookHandler, PluginRuntimeContext, ResolvedMcpConfig } from "./types.js";
import { SUPPORTED_HOOK_EVENTS } from "./types.js";
import { discoverArtifactDirs, resolveProjectRoot, dedupeByName } from "./discovery/locations.js";
import { loadSettings } from "./discovery/settings.js";
import { resolveMcpConfig } from "./discovery/mcp.js";
import { resolveClaudeProfile } from "./discovery/claude-profile.js";
import {
  discoverManagedMcp,
  type ManagedMcpDiscoveryOptions,
} from "./discovery/managed-policy.js";
import { loadMcpJson, type McpJsonResult } from "./claude/mcp-config.js";
import { loadClaudeMcpState } from "./claude/claude-mcp-state.js";
import { loadPluginSkills, loadSkills } from "./claude/skills.js";
import { loadAgents, loadPluginAgents } from "./claude/agents.js";
import { loadRules } from "./claude/rules.js";
import { loadClaudeMdHierarchy } from "./claude/claude-md.js";
import { loadAutoMemory, type MemorySnapshot } from "./claude/memory.js";
import { parseHookConfig, mergeHookConfigs } from "./claude/hooks.js";
import { loadPluginInstalledState } from "./claude/plugin-installed-state.js";
import { loadPluginMarketplaceState } from "./claude/plugin-marketplaces.js";
import { createPluginMetadataReadCapability } from "./claude/plugin-metadata.js";
import { buildPluginInventorySnapshot, type PluginInventoryCapabilityEvidence, type PluginInventorySnapshot } from "./plugin-inventory.js";
import { lookupCapability } from "./registry/capability-registry.js";
import {
  authorizedCacheRoots,
  loadPluginHooks,
  resolveInstalledPlugins,
  type InstalledPlugin,
} from "./claude/plugins.js";
import { projectIdentities } from "./util/project-identity.js";
import type { PluginResolutionOutcome } from "./types.js";
import { createLifecycleLocations } from "./plugin-lifecycle/locations.js";
import { createExecutableAdmissionGenerationCodec, createOwnedMarketplaceCodec, createOwnedMarketplaceSnapshotCodec, createOwnedPluginInstallationCodec, observeExecutableGenerationFile, readOwnedAdmissionRecords, type AdmittedOwnedInstallation, type CompleteOwnedProfileReference, type GenerationMarkerObservation, type MarketplaceSnapshotAuthority, type OwnedMarketplaceRecord } from "./plugin-lifecycle/admission.js";
import { createProducerCodecRegistry, type OwnedStateStore } from "./plugin-lifecycle/state-store.js";
import { assembledEnablement, observeLifecycleEnvelope, ownedMarketplaceProjection, projectOwnedAndImportedInstallations, uniquelySelectedApplicableOwnedWinner, type InstallationProjection, type LifecycleObservationEnvelope } from "./plugin-lifecycle/projection.js";
import { admitDependencyGraph } from "./plugin-lifecycle/dependency-admission.js";

/**
 * Assemble the full Claude-artifact model of a project: settings with
 * precedence, skills, agents, rules, CLAUDE.md hierarchy, and installed-plugin
 * content folded into the same registries.
 */
export interface LoadedProject extends ClaudeProject {
  /** Resolved MCP servers (always present here; empty config => `servers: []`). */
  mcp: ResolvedMcpConfig;
  /** Fully merged hook config: settings hooks + plugin hooks. */
  mergedHooks: HookConfig;
  plugins: InstalledPlugin[];
  pluginResolutionOutcomes: PluginResolutionOutcome[];
  pluginContexts: ReadonlyMap<string, PluginRuntimeContext>;
  pluginInventory: PluginInventorySnapshot;
  pluginAdmissions: readonly InstallationProjection[];
  ownedMarketplaces: readonly OwnedMarketplaceRecord[];
  lifecycleObservation: LifecycleObservationEnvelope;
  executableGenerationObservation: GenerationMarkerObservation;
  ownedProfileReference?: CompleteOwnedProfileReference;
  /** Auto memory: dir + truncated MEMORY.md; undefined when disabled. */
  autoMemory?: MemorySnapshot;
}

export function loadClaudeProject(opts: {
  cwd: string;
  userDir?: string;
  /** Injected profile policy inputs; production defaults to process state. */
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  /** Override managed/policy settings file locations (used by tests). */
  managedSettingsPaths?: string[];
  /** Override managed-policy platform selection (used by deterministic command tests). */
  managedPolicyPlatform?: NodeJS.Platform;
  /** Override managed/policy artifact base directories (used by tests). */
  managedArtifactDirs?: string[];
  /** Structural standalone managed-MCP authority reserved for deterministic tests. */
  managedMcpDiscovery?: ManagedMcpDiscoveryOptions;
  /** Counted/throwing ordinary MCP loader seam reserved for deterministic tests. */
  mcpOrdinaryLoadersForTest?: {
    loadNativeState(options: Parameters<typeof loadClaudeMcpState>[0]): ReturnType<typeof loadClaudeMcpState>;
    loadProjectMcpJson(projectRoot: string): McpJsonResult;
  };
  pluginInventoryLifetime?: "session" | "command";
}): LoadedProject {
  const diagnostics: Diagnostic[] = [];
  const env = opts.env ?? process.env;
  const cwd = path.resolve(opts.cwd);
  const profile = resolveClaudeProfile({
    ...(opts.userDir === undefined ? {} : { userDir: opts.userDir }),
    ...(opts.env === undefined ? {} : { env: opts.env }),
    ...(opts.homeDir === undefined ? {} : { homeDir: opts.homeDir }),
  });
  const userDir = profile.userDir;
  const root = resolveProjectRoot(cwd);
  // Every present standalone state suppresses ordinary MCP acquisition. Loaded
  // states are exclusive; unusable state is administrator-controlled fail-closed evidence.
  const managedMcp = discoverManagedMcp(opts.managedMcpDiscovery);

  const settings = loadSettings({
    cwd,
    projectRoot: root,
    userDir,
    managedPaths: opts.managedSettingsPaths,
    ...(opts.managedPolicyPlatform === undefined
      ? {}
      : { managedPolicy: { platform: opts.managedPolicyPlatform } }),
  });
  const dirs = discoverArtifactDirs({
    cwd,
    projectRoot: root,
    userDir,
    managedDirs: opts.managedArtifactDirs,
  });

  diagnostics.push(...settings.diagnostics);
  const installedState = loadPluginInstalledState(userDir);
  diagnostics.push(...installedState.diagnostics);
  const marketplaceState = loadPluginMarketplaceState({
    userDir,
    projectRoot: root,
    settings,
    env,
  });
  diagnostics.push(...marketplaceState.diagnostics);

  const lifecycleHome = path.resolve(opts.homeDir ?? os.homedir());
  const lifecycleProjectIdentities = projectIdentities(root);
  const activeCheckoutPath = lifecycleProjectIdentities.at(-1);
  const checkoutFamilyPath = lifecycleProjectIdentities[0];
  const lifecycleLocationsResult = activeCheckoutPath === undefined || checkoutFamilyPath === undefined
    ? { ok: false as const }
    : createLifecycleLocations({
      homeDir: lifecycleHome, profilePath: userDir, platform: process.platform === "win32" ? "win32" : "posix",
      project: { activeCheckoutPath, checkoutFamilyPath },
    });
  let pluginAdmissions: readonly InstallationProjection[] = installedState.installations.map((installation) => Object.freeze({ ownership: "claude-imported-readonly" as const, installation }));
  let ownedMarketplaces: readonly OwnedMarketplaceRecord[] = Object.freeze([]);
  let lifecycleObservation: LifecycleObservationEnvelope = Object.freeze({ records: Object.freeze([]), receipts: Object.freeze([]), pending: Object.freeze([]) });
  let executableGenerationObservation: GenerationMarkerObservation = Object.freeze({ status: "absent" });
  let ownedProfileReference: CompleteOwnedProfileReference | undefined;
  if (lifecycleLocationsResult.ok) {
    const locations = lifecycleLocationsResult.value;
    const store: OwnedStateStore = Object.freeze({ root: locations.profileRoot, profileRoot: locations.profileRoot, profileKey: locations.profileKey,
      artifactsRoot: path.join(locations.profileRoot, "artifacts", "sha256"), recordsRoot: path.join(locations.profileRoot, "records"), stagingRoot: path.join(locations.profileRoot, "staging"),
      generationsRoot: path.join(locations.profileRoot, "generations"), journalsRoot: path.join(locations.profileRoot, "journals"), receiptsRoot: path.join(locations.profileRoot, "receipts"),
      locksRoot: path.join(locations.profileRoot, "locks"), quarantineRoot: path.join(locations.profileRoot, "quarantine") });
    const marketplaceCodec = createOwnedMarketplaceCodec(locations.profileKey);
    const marketplaceSnapshotCodec = createOwnedMarketplaceSnapshotCodec({ profileKey: locations.profileKey, artifactsRoot: store.artifactsRoot });
    const preliminaryRegistry = createProducerCodecRegistry([marketplaceCodec, marketplaceSnapshotCodec]);
    const preliminary = preliminaryRegistry.ok ? readOwnedAdmissionRecords(store, preliminaryRegistry.value, undefined) : { marketplaces: [], marketplaceSnapshots: [], records: [], installations: [] };
    const snapshotAuthorities = new Map<string, MarketplaceSnapshotAuthority[]>(); const overflowingSnapshotIds = new Set<string>();
    for (const record of preliminary.marketplaceSnapshots) {
      const authorities = snapshotAuthorities.get(record.snapshotId) ?? [];
      if (authorities.length < 128) authorities.push(record); else overflowingSnapshotIds.add(record.snapshotId);
      snapshotAuthorities.set(record.snapshotId, authorities);
    }
    for (const snapshotId of overflowingSnapshotIds) snapshotAuthorities.set(snapshotId, []);
    const snapshots = Object.fromEntries([...snapshotAuthorities].map(([snapshotId, authorities]) => [snapshotId, Object.freeze(authorities)]));
    const installationCodec = createOwnedPluginInstallationCodec({ profileKey: locations.profileKey, artifactsRoot: store.artifactsRoot, marketplaceSnapshots: snapshots });
    const generationCodec = createExecutableAdmissionGenerationCodec(locations.profileKey);
    executableGenerationObservation = observeExecutableGenerationFile(path.join(store.generationsRoot, "current.json"), generationCodec);
    const registry = createProducerCodecRegistry([marketplaceCodec, marketplaceSnapshotCodec, installationCodec]);
    const admission = registry.ok ? readOwnedAdmissionRecords(store, registry.value, executableGenerationObservation.status === "valid" ? executableGenerationObservation.generation : undefined) : { marketplaces: [], marketplaceSnapshots: [], records: [], installations: [] as AdmittedOwnedInstallation[] };
    if (executableGenerationObservation.status === "valid" && admission.completeReference === undefined) executableGenerationObservation = { status: "membership-invalid", code: "generation-incomplete", generation: executableGenerationObservation.generation };
    ownedProfileReference = admission.completeReference;
    ownedMarketplaces = ownedMarketplaceProjection(admission.marketplaces, admission.marketplaceSnapshots, { checkoutFamilyKey: locations.checkoutFamilyKey!, projectKey: locations.checkoutFamilyKey! });
    const projected = projectOwnedAndImportedInstallations({ imported: installedState.installations, owned: admission.installations, locations, projectPath: root });
    pluginAdmissions = projected.projections;
    for (const conflict of projected.conflicts) diagnostics.push({ severity: "warning", message: `Owned/imported plugin authority conflict for ${conflict}; all conflicting records remained inert` });
    lifecycleObservation = observeLifecycleEnvelope(store, admission.records);
  }
  const runtimeInstallations = pluginAdmissions.map((projection) => projection.ownership === "picc-owned" ? projection : projection.installation);
  let effectivePluginEnablement = assembledEnablement({ projections: pluginAdmissions, explicit: settings.effectivePluginEnablement ?? {}, projectPath: root });
  let pluginResult = resolveInstalledPlugins({ userDir, projectRoot: root, enablement: effectivePluginEnablement, installations: runtimeInstallations, installedStateStatus: installedState.status, env });
  const manifestDisabled = pluginResult.outcomes.filter((outcome) => outcome.manifestDefaultEnabled?.presence === "explicit" && outcome.manifestDefaultEnabled.value === false
    && !Object.hasOwn(settings.effectivePluginEnablement ?? {}, outcome.pluginId)
    && uniquelySelectedApplicableOwnedWinner(pluginAdmissions, outcome.pluginId, root)?.marketplaceDefaultEnabled === undefined);
  if (manifestDisabled.length > 0) {
    effectivePluginEnablement = Object.freeze({ ...effectivePluginEnablement, ...Object.fromEntries(manifestDisabled.map((outcome) => [outcome.pluginId, { enabled: false, scope: "user" as const, source: outcome.manifestDefaultEnabled!.sourcePath }])) });
    pluginResult = resolveInstalledPlugins({ userDir, projectRoot: root, enablement: effectivePluginEnablement, installations: runtimeInstallations, installedStateStatus: installedState.status, env });
  }
  diagnostics.push(...pluginResult.diagnostics);
  const selectedPlugins = pluginResult.plugins;
  let plugins = selectedPlugins;
  const pluginResolutionOutcomes = [...pluginResult.outcomes];

  // Project/user artifacts retain precedence. Installed plugin contributions are
  // committed only after every independently resolved loader input remains valid.
  const skillsResult = loadSkills(dirs.skillDirs, dirs.commandDirs);
  diagnostics.push(...skillsResult.diagnostics);
  let skills = skillsResult.skills;
  const agentsResult = loadAgents(dirs.agentDirs);
  diagnostics.push(...agentsResult.diagnostics);
  let agents = agentsResult.agents;
  const loadedPluginSkills = new Map<string, ClaudeSkill[]>();
  const loadedPluginAgents = new Map<string, typeof agents>();
  const loadedPluginHooks = new Map<string, ReturnType<typeof loadPluginHooks>>();
  const inventoryCapabilityEvidence: PluginInventoryCapabilityEvidence[] = [];
  type FinalLoadedPluginComponents = { skills: number; commands: number; agents: number; hooks: number };
  const finalLoadedComponents: Record<string, FinalLoadedPluginComponents> = {};
  const rejectedAtLoad = new Set<string>();
  for (const plugin of plugins) {
    const outcome = pluginResolutionOutcomes.find((item) => item.pluginId === plugin.pluginId)!;
    const pluginSkills = loadPluginSkills(plugin.skillSources, plugin.commandSources);
    const pluginAgents = loadPluginAgents(plugin.agentSources);
    const stagedAgentEvidence: PluginInventoryCapabilityEvidence[] = [];
    for (const agent of pluginAgents.agents) for (const field of ["hooks", "mcpServers", "permissionMode"] as const) {
      if (agent.diagnostics.some((entry) => entry.message.includes(`field "${field}"`))) stagedAgentEvidence.push({
        capabilityId: `agent.frontmatter.${field}`,
        qualifiedIdentity: plugin.pluginId,
        component: agent.name,
        observation: `Plugin agent field ${field} was stripped before runtime construction`,
      });
    }
    const pluginHooks = loadPluginHooks(plugin);
    const loaderEvidence = [
      ...safeLoaderEvidence("skill/command", pluginSkills.diagnostics),
      ...safeLoaderEvidence("agent", pluginAgents.diagnostics),
      ...safeLoaderEvidence("hook source", pluginHooks.diagnostics),
      ...safeLoaderEvidence("plugin", plugin.diagnostics),
    ];
    diagnostics.push(...pluginSkills.diagnostics, ...pluginAgents.diagnostics, ...pluginHooks.diagnostics);
    const terminalSkillEvidence = safeLoaderEvidence(
      "skill/command",
      pluginSkills.pathFailures?.filter((failure) => failure.terminal).map((failure) => failure.failure.diagnostic) ?? [],
    );
    const terminalAgentEvidence = safeLoaderEvidence(
      "agent",
      pluginAgents.pathFailures?.filter((failure) => failure.terminal).map((failure) => failure.failure.diagnostic) ?? [],
    );
    const terminalHookEvidence = safeLoaderEvidence("hook source", pluginHooks.rejectionDiagnostics);
    if (terminalSkillEvidence.length > 0 || terminalAgentEvidence.length > 0 || pluginHooks.rejected) {
      rejectedAtLoad.add(plugin.pluginId);
      const rejection = {
        severity: "warning" as const,
        message: "Installed plugin components could not be loaded safely; all contributions were rejected",
      };
      outcome.diagnostics = boundedOutcomeDiagnostics(
        outcome.diagnostics,
        loaderEvidence,
        [...terminalSkillEvidence, ...terminalAgentEvidence, ...terminalHookEvidence, rejection],
      );
      diagnostics.push(rejection);
      continue;
    }
    outcome.diagnostics = boundedOutcomeDiagnostics(outcome.diagnostics, loaderEvidence);

    inventoryCapabilityEvidence.push(...stagedAgentEvidence);
    loadedPluginSkills.set(plugin.pluginId, namespacePluginContent(pluginSkills.skills, plugin.name));
    loadedPluginAgents.set(plugin.pluginId, namespacePluginContent(pluginAgents.agents, plugin.name));
    loadedPluginHooks.set(plugin.pluginId, pluginHooks);
    finalLoadedComponents[plugin.pluginId] = { skills: 0, commands: 0, agents: 0, hooks: 0 };
  }
  if (rejectedAtLoad.size > 0) {
    const finalDependencyDecisions = admitDependencyGraph(selectedPlugins.map((plugin) => ({
      pluginId: plugin.pluginId, version: plugin.version, enabled: true, available: !rejectedAtLoad.has(plugin.pluginId),
      ownership: plugin.ownership ?? "claude-imported-readonly", dependencies: plugin.manifestProjection.dependencies,
      dependencyDeclaration: plugin.manifestProjection.dependencyDeclaration,
      ...(plugin.allowedCrossMarketplaceDependencies === undefined ? {} : { allowedCrossMarketplaceDependencies: plugin.allowedCrossMarketplaceDependencies }),
    })));
    for (const decision of finalDependencyDecisions) {
      if (decision.admitted || rejectedAtLoad.has(decision.pluginId) || selectedPlugins.find((plugin) => plugin.pluginId === decision.pluginId)?.ownership !== "picc-owned") continue;
      rejectedAtLoad.add(decision.pluginId);
      const outcome = pluginResolutionOutcomes.find((item) => item.pluginId === decision.pluginId);
      const rejection = { severity: "warning" as const, message: `Installed owned plugin failed final dependency admission (${decision.reasons.join(", ")}); all contributions were rejected` };
      if (outcome !== undefined) outcome.diagnostics = boundedOutcomeDiagnostics(outcome.diagnostics, [], [rejection]);
      diagnostics.push(rejection);
    }
    plugins = plugins.filter((plugin) => !rejectedAtLoad.has(plugin.pluginId));
    for (const outcome of pluginResolutionOutcomes) {
      if (rejectedAtLoad.has(outcome.pluginId)) {
        outcome.status = "rejected";
        outcome.context = undefined;
        outcome.sources = undefined;
      }
    }
  }
  for (const plugin of plugins) {
    skills = dedupeByName([...skills, ...(loadedPluginSkills.get(plugin.pluginId) ?? [])]);
    agents = dedupeByName([...agents, ...(loadedPluginAgents.get(plugin.pluginId) ?? [])]);
  }

  skills = applySkillOverrides(skills, settings.skillOverrides, diagnostics);

  const rulesResult = loadRules(dirs.ruleDirs, {
    excludes: settings.claudeMdExcludes,
    projectRoot: root,
  });
  diagnostics.push(...rulesResult.diagnostics);

  // CLAUDE.md hierarchy (managed CLAUDE.md + inline managed `claudeMd` first).
  const claudeMdResult = loadClaudeMdHierarchy({
    cwd,
    projectRoot: root,
    userDir,
    excludes: settings.claudeMdExcludes,
    managedDirs: opts.managedArtifactDirs,
    managedInline: settings.managedClaudeMd,
  });
  diagnostics.push(...claudeMdResult.diagnostics);

  // Auto memory, read side: undefined when disabled by setting or env.
  const autoMemory = loadAutoMemory(root, userDir, settings);

  // The resolver prepares policy from one environment snapshot before deciding
  // whether ordinary acquisition can affect admission. These callbacks are test
  // authority only and are never project data.
  const ordinaryLoaders = opts.mcpOrdinaryLoadersForTest ?? {
    loadNativeState: loadClaudeMcpState,
    loadProjectMcpJson: loadMcpJson,
  };
  const mcp = resolveMcpConfig({
    projectRoot: root,
    loadOrdinaryMcp: () => ({
      nativeState: ordinaryLoaders.loadNativeState({
        statePath: profile.nativeStatePath,
        projectRoot: root,
      }),
      mcpJson: ordinaryLoaders.loadProjectMcpJson(root),
    }),
    mcpSettings: settings.mcpSettings ?? [],
    nativeStateProfile: profile.source,
    mcpPolicySettings: settings.mcpPolicySettings,
    mcpPolicySourceFailures: settings.mcpPolicySourceFailures,
    mcpPolicyRestrictiveMaterialOmitted: settings.mcpPolicyRestrictiveMaterialOmitted,
    managedMcp,
    ...(opts.env === undefined ? {} : { env: opts.env }),
  });

  const hookConfigs: HookConfig[] = [settings.hooks];
  for (const plugin of plugins) {
    const rawHooks = loadedPluginHooks.get(plugin.pluginId)!;
    if (Object.keys(rawHooks.config).length) {
      const parsed = parseHookConfig(rawHooks.config, `plugin:${plugin.pluginId}`, { pluginId: plugin.pluginId });
      diagnostics.push(...parsed.diagnostics);
      for (const [event, entries] of Object.entries(parsed.config)) {
        const eventCapabilityId = `hook.event.${event}`;
        const eventCapability = lookupCapability(eventCapabilityId);
        if (eventCapability === undefined || eventCapability.tier !== "full") inventoryCapabilityEvidence.push({
          capabilityId: eventCapabilityId,
          qualifiedIdentity: plugin.pluginId,
          component: event,
          observation: eventCapability === undefined ? "Plugin hook event is unassessed because its capability registry entry is absent" : `Plugin hook event support is ${eventCapability.tier}`,
        });
        for (const entry of entries) for (const handler of entry.hooks) {
          if (handler.type === "command") continue;
          const blockingMcp = handler.type === "mcp_tool" && ["PreToolUse", "PermissionRequest", "UserPromptSubmit", "Stop", "SubagentStop", "WorktreeCreate"].includes(event);
          const capabilityId = blockingMcp ? "feature.hook-handler.mcp_tool-blocking-enforcement" : `feature.hook-handler.${handler.type}`;
          const capability = lookupCapability(capabilityId);
          inventoryCapabilityEvidence.push({
            capabilityId,
            qualifiedIdentity: plugin.pluginId,
            component: event,
            observation: capability === undefined ? "Plugin hook handler is unassessed" : `Plugin hook handler support is ${capability.tier}`,
          });
        }
      }
      const outcome = pluginResolutionOutcomes.find((item) => item.pluginId === plugin.pluginId)!;
      outcome.diagnostics = boundedOutcomeDiagnostics(
        outcome.diagnostics,
        safeLoaderEvidence("hook", parsed.diagnostics),
      );
      hookConfigs.push(parsed.config);
    }
  }

  const mergedHooks = mergeHookConfigs(...hookConfigs);
  for (const pluginId of Object.keys(finalLoadedComponents)) finalLoadedComponents[pluginId] = { skills: 0, commands: 0, agents: 0, hooks: 0 };
  const incrementFinal = (pluginId: string | undefined, field: keyof FinalLoadedPluginComponents): void => {
    if (pluginId === undefined || finalLoadedComponents[pluginId] === undefined) return;
    finalLoadedComponents[pluginId] = { ...finalLoadedComponents[pluginId], [field]: finalLoadedComponents[pluginId][field] + 1 };
  };
  for (const skill of skills) incrementFinal(skill.source.pluginId, skill.legacyCommand ? "commands" : "skills");
  for (const agent of agents) incrementFinal(agent.source.pluginId, "agents");
  const finalPluginContexts = new Map(plugins.map((plugin) => [plugin.pluginId, plugin.context]));
  for (const [event, entries] of Object.entries(mergedHooks)) {
    if (!(SUPPORTED_HOOK_EVENTS as readonly string[]).includes(event)) continue;
    const seenHandlers = new Set<string>();
    for (const entry of entries) for (const handler of entry.hooks) {
      if (!runtimeValidInventoryHandler(handler)) continue;
      const key = JSON.stringify([
        entry.matcher ?? null,
        entry.if ?? null,
        inventoryHookDedupKey(handler, finalPluginContexts.get(handler.pluginId ?? "")),
      ]);
      if (seenHandlers.has(key)) continue;
      seenHandlers.add(key);
      incrementFinal(handler.pluginId, "hooks");
    }
  }

  const inventoryIdentities = projectIdentities(root);
  const inventoryProjectRoot = inventoryIdentities.at(-1) ?? root;
  const inventoryMainCheckout = inventoryIdentities.length > 1 ? inventoryIdentities[0] : undefined;
  const pluginInventory = buildPluginInventorySnapshot({
    lifetime: opts.pluginInventoryLifetime ?? "session",
    projectRoot: inventoryProjectRoot,
    ...(inventoryMainCheckout === undefined ? {} : { mainCheckout: inventoryMainCheckout }),
    userDir,
    installedStateStatus: installedState.status,
    installedObservations: installedState.observations,
    installedObservationDiagnostics: installedState.observationDiagnostics,
    installedObservationOmissions: { ...installedState.observationOmissions },
    metadataReadCapability: createPluginMetadataReadCapability(authorizedCacheRoots(userDir, env)),
    enablementDiagnostics: settings.diagnostics,
    marketplaceState,
    enablement: effectivePluginEnablement,
    outcomes: pluginResolutionOutcomes,
    selectedPlugins,
    finalLoadedComponents,
    diagnostics: [...installedState.diagnostics, ...diagnostics.filter((entry) => entry.category !== undefined)],
    capabilityEvidence: inventoryCapabilityEvidence,
  });

  return {
    root,
    cwd,
    userDir,
    settings,
    skills,
    agents,
    rules: rulesResult.rules,
    claudeMd: claudeMdResult.files,
    mcp,
    diagnostics,
    mergedHooks,
    plugins,
    pluginResolutionOutcomes,
    pluginContexts: new Map(plugins.map((plugin) => [plugin.pluginId, plugin.context])),
    pluginInventory,
    pluginAdmissions,
    ownedMarketplaces,
    lifecycleObservation,
    executableGenerationObservation,
    ...(ownedProfileReference === undefined ? {} : { ownedProfileReference }),
    autoMemory,
  };
}

/**
 * Claude Code namespaces plugin skills/agents/commands as `plugin-name:name`
 * (`my-plugin/skills/review/` → `/my-plugin:review`). The bare name stays
 * reachable via {@link findByName} when unambiguous.
 */
function safeLoaderEvidence(component: string, entries: readonly Diagnostic[]): Diagnostic[] {
  return entries.map((entry) => {
    const message = entry.message.toLowerCase();
    const reason = message.includes("unreadable") || message.includes("cannot read") ? "unreadable content"
      : message.includes("malformed") || message.includes("no description") || message.includes("not a valid") ? "malformed content"
      : message.includes("unsupported") || message.includes("not allowed") || message.includes("ignored") ? "unsupported content"
      : message.includes("path") || message.includes("filesystem") ? "path validation failure"
      : "a loader warning";
    return { severity: entry.severity, message: `Installed plugin ${component} loader reported ${reason}` };
  });
}

function runtimeValidInventoryHandler(handler: HookHandler): boolean {
  if (handler.type === "command") return typeof handler.command === "string" && handler.command.length > 0;
  return handler.type === "http" && typeof handler.url === "string" && handler.url.length > 0;
}

/** Mirrors the hook runner's per-event execution identity without becoming an execution seam. */
function inventoryHookDedupKey(handler: HookHandler, context: PluginRuntimeContext | undefined): string {
  return JSON.stringify([
    handler.pluginId ?? null, context?.root ?? null, context?.dataDir ?? null, context?.projectDir ?? null,
    handler.type, handler.command ?? null, handler.args ?? null, handler.shell ?? null, handler.url ?? null,
  ]);
}

function boundedOutcomeDiagnostics(
  existing: readonly Diagnostic[],
  ordinary: readonly Diagnostic[],
  reserved: readonly Diagnostic[] = [],
): Diagnostic[] {
  const unique = (entries: readonly Diagnostic[]): Diagnostic[] => {
    const seen = new Set<string>();
    return entries.filter((entry) => {
      const key = `${entry.severity}\0${entry.message}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  };
  const terminal = unique(reserved).slice(-20);
  const terminalKeys = new Set(terminal.map((entry) => `${entry.severity}\0${entry.message}`));
  const prefix = unique([...existing, ...ordinary])
    .filter((entry) => !terminalKeys.has(`${entry.severity}\0${entry.message}`))
    .slice(0, 20 - terminal.length);
  return [...prefix, ...terminal];
}

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
 * Apply the settings `skillOverrides` map: per skill name,
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

import type { ToolDefinition, ToolInfo } from "@earendil-works/pi-coding-agent";
import type { McpCatalogDelta, McpCatalogToolDefinition } from "./mcp-control.js";
import { McpPromptCatalogStore, type McpPromptCatalog } from "./mcp-prompts.js";
import {
  buildMcpResourceTools,
  ListMcpResourcesTool,
  ReadMcpResourceTool,
  type McpResourceSource,
} from "./mcp-resources.js";
import { buildMcpProxyTool, mcpProxyToolName, type McpToolSource } from "./mcp-tools.js";

type AnyToolDefinition = ToolDefinition<any, any>;
type HostToolInfo = Pick<ToolInfo, "name" | "description" | "parameters" | "promptGuidelines" | "sourceInfo">;

export interface McpExposureHost {
  registerTool(definition: AnyToolDefinition): void;
  getActiveTools(): string[];
  getAllTools(): readonly HostToolInfo[];
  setActiveTools(names: string[]): void;
  isCoordinatorSourceInfo(sourceInfo: HostToolInfo["sourceInfo"]): boolean;
}

export interface McpExposurePermissionGate {
  gateTools(
    granted: string[] | undefined,
    disallowed: string[] | undefined,
    allKnown: string[],
  ): string[];
}

export type McpExposureSource = Pick<McpToolSource, "callTool"> & McpResourceSource;

export interface McpExposureOptions {
  readonly host: McpExposureHost;
  readonly source: McpExposureSource;
  readonly permissionGate: McpExposurePermissionGate;
  readonly clipMaxTokens: number;
  readonly reservedPromptNames: () => ReadonlySet<string> | readonly string[];
  readonly prepareTool?: (definition: AnyToolDefinition) => AnyToolDefinition;
}

export interface McpExposureResult {
  readonly state: "applied" | "stale" | "failed";
  readonly serverName: string;
  readonly generation: number;
  readonly registered: readonly string[];
  readonly refreshed: readonly string[];
  readonly activated: readonly string[];
  readonly deactivated: readonly string[];
  readonly denied: readonly string[];
  readonly collisions: readonly string[];
  readonly failures: readonly string[];
  /** Pi's slash-command discovery is startup-bounded; typed invocation uses this live catalog. */
  readonly paletteRefreshAvailable: false;
}

interface PublishedCatalog {
  readonly definitionFingerprint: string;
  readonly generation: number;
  readonly tools: readonly McpCatalogToolDefinition[];
  readonly prompts: McpCatalogDelta["prompts"];
  readonly resourceServer?: NonNullable<McpCatalogDelta["resourceServer"]>;
}

interface DesiredTool {
  readonly definition: AnyToolDefinition;
  readonly fingerprint: string;
}

interface OwnedTool {
  readonly fingerprint: string;
  readonly visible: HostToolInfo;
}

interface RetainedResult {
  readonly key: string;
  readonly generation: number;
  readonly completion: Promise<McpExposureResult>;
  completed?: McpExposureResult;
}

type RegistrationTransition = "registered" | "refreshed";

interface ResultValues {
  registered: string[];
  refreshed: string[];
  activated: string[];
  deactivated: string[];
  denied: string[];
  collisions: string[];
  failures: string[];
}

const RESOURCE_DEFINITION_FINGERPRINTS = new Map<string, string>([
  [ListMcpResourcesTool, "picc:mcp-resource-list:v1"],
  [ReadMcpResourceTool, "picc:mcp-resource-read:v1"],
]);

function deltaKey(delta: McpCatalogDelta): string {
  return `${delta.kind}\u0000${delta.definitionFingerprint}`;
}

function unique(names: readonly string[]): string[] {
  return [...new Set(names)];
}

function frozenResult(
  delta: McpCatalogDelta,
  state: McpExposureResult["state"],
  values: ResultValues,
): McpExposureResult {
  return Object.freeze({
    state,
    serverName: delta.serverName,
    generation: delta.generation,
    registered: Object.freeze(unique(values.registered)),
    refreshed: Object.freeze(unique(values.refreshed)),
    activated: Object.freeze(unique(values.activated)),
    deactivated: Object.freeze(unique(values.deactivated)),
    denied: Object.freeze(unique(values.denied)),
    collisions: Object.freeze(unique(values.collisions)),
    failures: Object.freeze(unique(values.failures)),
    paletteRefreshAvailable: false,
  });
}

function emptyValues(): ResultValues {
  return { registered: [], refreshed: [], activated: [], deactivated: [], denied: [], collisions: [], failures: [] };
}

function emptyResult(delta: McpCatalogDelta, state: "stale" | "failed"): McpExposureResult {
  return frozenResult(delta, state, emptyValues());
}

function visibleDefinitionMatches(info: HostToolInfo, definition: AnyToolDefinition): boolean {
  return info.name === definition.name && info.description === definition.description &&
    info.parameters === definition.parameters && info.promptGuidelines === definition.promptGuidelines;
}

function ownershipMatches(info: HostToolInfo | undefined, owned: OwnedTool): boolean {
  return info !== undefined && info.sourceInfo === owned.visible.sourceInfo &&
    info.description === owned.visible.description && info.parameters === owned.visible.parameters &&
    info.promptGuidelines === owned.visible.promptGuidelines;
}

/** Main-session coordinator for generation-safe MCP catalog publication. */
export class McpMainSessionExposure {
  private readonly catalogs = new Map<string, PublishedCatalog>();
  private readonly latestGenerations = new Map<string, number>();
  private readonly retainedResults = new Map<string, RetainedResult>();
  private readonly owned = new Map<string, OwnedTool>();
  private readonly failedRegistrationResidues = new Map<string, RegistrationTransition>();
  private readonly relinquished = new Set<string>();
  private readonly promptStore: McpPromptCatalogStore;
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly options: McpExposureOptions) {
    this.promptStore = new McpPromptCatalogStore(options.reservedPromptNames);
  }

  promptCatalog(): McpPromptCatalog {
    return this.promptStore.current();
  }

  apply(delta: McpCatalogDelta): Promise<McpExposureResult> {
    const latest = this.latestGenerations.get(delta.serverName) ?? 0;
    const retained = this.retainedResults.get(delta.serverName);
    const key = deltaKey(delta);
    if (delta.generation < latest) return Promise.resolve(emptyResult(delta, "stale"));
    if (delta.generation === latest) {
      if (retained?.generation !== latest || retained.key !== key) return Promise.resolve(emptyResult(delta, "stale"));
      if (retained.completed?.state !== "failed") return retained.completion;
    } else {
      this.latestGenerations.set(delta.serverName, delta.generation);
    }

    const completion = this.queue.then(() => this.commit(delta));
    this.queue = completion.then(() => undefined, () => undefined);
    const nextRetained: RetainedResult = { key, generation: delta.generation, completion };
    this.retainedResults.set(delta.serverName, nextRetained);
    void completion.then((result) => { nextRetained.completed = result; });
    return completion;
  }

  private isCurrent(delta: McpCatalogDelta): boolean {
    return this.latestGenerations.get(delta.serverName) === delta.generation;
  }

  private admitted(names: readonly string[]): Set<string> {
    return new Set(this.options.permissionGate.gateTools(undefined, undefined, [...names]));
  }

  private configured(): Map<string, HostToolInfo> {
    return new Map(this.options.host.getAllTools().map((tool) => [tool.name, tool]));
  }

  private reconcileOwnership(configured: ReadonlyMap<string, HostToolInfo>, collisions: string[]): void {
    for (const [name, owned] of this.owned) {
      if (ownershipMatches(configured.get(name), owned)) continue;
      this.owned.delete(name);
      this.relinquished.add(name);
      collisions.push(name);
    }
  }

  private stillOwned(name: string): boolean {
    const owned = this.owned.get(name);
    return owned !== undefined && ownershipMatches(this.configured().get(name), owned);
  }

  private compensateVisibleRegistration(name: string, visible: HostToolInfo, values: ResultValues): void {
    const current = this.configured().get(name);
    if (!current || !ownershipMatches(current, { fingerprint: "", visible })) return;
    const before = this.options.host.getActiveTools();
    if (!before.includes(name)) return;
    try {
      const boundary = this.configured().get(name);
      if (!boundary || !ownershipMatches(boundary, { fingerprint: "", visible })) return;
      const fresh = this.options.host.getActiveTools();
      this.options.host.setActiveTools(fresh.filter((entry) => entry !== name));
    } catch {
      values.failures.push("compensation");
    }
    if (!this.options.host.getActiveTools().includes(name)) values.deactivated.push(name);
  }

  private async compensateNewRegistrations(
    names: readonly string[],
    values: ResultValues,
  ): Promise<void> {
    const removable = names.filter((name) => this.stillOwned(name));
    if (removable.length === 0) return;
    const before = this.options.host.getActiveTools();
    const next = before.filter((name) => !removable.includes(name));
    if (next.length === before.length) return;
    try {
      // Compensation is remove-only. Re-read ownership immediately before the side effect.
      const exact = removable.filter((name) => this.stillOwned(name));
      const fresh = this.options.host.getActiveTools();
      this.options.host.setActiveTools(fresh.filter((name) => !exact.includes(name)));
    } catch {
      values.failures.push("compensation");
    }
    const observed = this.options.host.getActiveTools();
    for (const name of before) {
      if (!observed.includes(name) && this.owned.has(name)) values.deactivated.push(name);
    }
  }

  private async staleAfterSideEffect(
    delta: McpCatalogDelta,
    newlyActive: readonly string[],
    values: ResultValues,
  ): Promise<boolean> {
    if (this.isCurrent(delta)) return false;
    await this.compensateNewRegistrations(newlyActive, values);
    return true;
  }

  private async commit(delta: McpCatalogDelta): Promise<McpExposureResult> {
    if (!this.isCurrent(delta)) return emptyResult(delta, "stale");

    if (delta.kind === "publish") {
      this.catalogs.set(delta.serverName, Object.freeze({
        definitionFingerprint: delta.definitionFingerprint,
        generation: delta.generation,
        tools: delta.tools,
        prompts: delta.prompts,
        ...(delta.resourceServer ? { resourceServer: delta.resourceServer } : {}),
      }));
    } else {
      const current = this.catalogs.get(delta.serverName);
      if (current?.definitionFingerprint === delta.definitionFingerprint) this.catalogs.delete(delta.serverName);
    }
    if (!this.isCurrent(delta)) return emptyResult(delta, "stale");

    const { desired, ambiguous } = this.desiredTools();
    const desiredNames = [...desired.keys()];
    const values = emptyValues();
    values.collisions.push(...ambiguous);
    const plannedAdmission = this.admitted(desiredNames);
    for (const name of desiredNames) if (!plannedAdmission.has(name)) values.denied.push(name);

    // Keep planning and commit in separate turns so a newer generation can fence this one.
    await Promise.resolve();
    if (!this.isCurrent(delta)) return emptyResult(delta, "stale");

    for (const [name, entry] of desired) {
      if (!this.isCurrent(delta)) return frozenResult(delta, "stale", values);
      const admission = this.admitted(desiredNames);
      if (!plannedAdmission.has(name) || !admission.has(name)) {
        values.denied.push(name);
        continue;
      }

      let configured = this.configured();
      this.reconcileOwnership(configured, values.collisions);
      const previous = this.owned.get(name);
      if (this.relinquished.has(name)) {
        values.collisions.push(name);
        continue;
      }
      if (previous === undefined && configured.has(name)) {
        this.relinquished.add(name);
        values.collisions.push(name);
        continue;
      }
      if (previous?.fingerprint === entry.fingerprint && !this.failedRegistrationResidues.has(name)) continue;
      if (previous && !ownershipMatches(configured.get(name), previous)) continue;

      const definition = this.options.prepareTool?.(entry.definition) ?? entry.definition;
      configured = this.configured(); // Immediately before first registration or refresh.
      this.reconcileOwnership(configured, values.collisions);
      if (!this.isCurrent(delta) || !this.admitted(desiredNames).has(name)) {
        values.denied.push(name);
        continue;
      }
      const currentOwner = this.owned.get(name);
      if (previous === undefined) {
        if (this.relinquished.has(name) || configured.has(name)) {
          this.relinquished.add(name);
          values.collisions.push(name);
          continue;
        }
      } else if (!currentOwner || !ownershipMatches(configured.get(name), currentOwner)) {
        continue;
      }

      const activeBeforeRegistration = this.options.host.getActiveTools();
      const registrationAdmission = this.admitted(desiredNames);
      const registrationConfigured = this.configured();
      this.reconcileOwnership(registrationConfigured, values.collisions);
      if (!this.isCurrent(delta) || !registrationAdmission.has(name)) {
        values.denied.push(name);
        continue;
      }
      const registrationOwner = this.owned.get(name);
      if (previous === undefined) {
        if (registrationConfigured.has(name) || this.relinquished.has(name)) {
          this.relinquished.add(name);
          values.collisions.push(name);
          continue;
        }
      } else if (!registrationOwner || !ownershipMatches(registrationConfigured.get(name), registrationOwner)) {
        continue;
      }
      const transition = this.failedRegistrationResidues.get(name) ??
        (previous === undefined ? "registered" : "refreshed");
      try {
        this.options.host.registerTool(definition);
      } catch {
        values.failures.push(`registration:${name}`);
        const failedVisible = this.configured().get(name);
        if (failedVisible && visibleDefinitionMatches(failedVisible, definition) &&
          this.options.host.isCoordinatorSourceInfo(failedVisible.sourceInfo)) {
          this.owned.set(name, { fingerprint: entry.fingerprint, visible: failedVisible });
          this.failedRegistrationResidues.set(name, transition);
          values[transition].push(name);
          if (!activeBeforeRegistration.includes(name) && this.options.host.getActiveTools().includes(name)) {
            values.activated.push(name);
          }
          this.compensateVisibleRegistration(name, failedVisible, values);
        } else if ((previous && ownershipMatches(failedVisible, previous)) || (!previous && !failedVisible)) {
          this.failedRegistrationResidues.set(name, transition);
        } else {
          this.owned.delete(name);
          this.failedRegistrationResidues.delete(name);
          this.relinquished.add(name);
          values.collisions.push(name);
        }
        continue;
      }

      const observed = this.configured();
      const visible = observed.get(name);
      if (!visible || !visibleDefinitionMatches(visible, definition) ||
        !this.options.host.isCoordinatorSourceInfo(visible.sourceInfo)) {
        this.owned.delete(name);
        this.failedRegistrationResidues.delete(name);
        this.relinquished.add(name);
        values.collisions.push(name);
        continue;
      }
      this.failedRegistrationResidues.delete(name);
      this.owned.set(name, { fingerprint: entry.fingerprint, visible });
      values[transition].push(name);
      const autoactivated = !activeBeforeRegistration.includes(name) && this.options.host.getActiveTools().includes(name)
        ? [name]
        : [];
      values.activated.push(...autoactivated);
      if (await this.staleAfterSideEffect(delta, autoactivated, values)) {
        return frozenResult(delta, "stale", values);
      }
      if (!this.admitted(desiredNames).has(name)) {
        values.denied.push(name);
        await this.compensateNewRegistrations(previous === undefined ? [name] : [], values);
      }
    }

    if (!this.isCurrent(delta)) return frozenResult(delta, "stale", values);
    const configured = this.configured();
    this.reconcileOwnership(configured, values.collisions);
    const commitAdmission = this.admitted(desiredNames);
    for (const name of desiredNames) if (!commitAdmission.has(name)) values.denied.push(name);

    const activate = desiredNames.filter((name) => commitAdmission.has(name) && this.owned.has(name) &&
      !values.failures.includes(`registration:${name}`) && !values.collisions.includes(name));

    let activeSetFailed = false;
    {
      this.reconcileOwnership(this.configured(), values.collisions);
      if (!this.isCurrent(delta)) return frozenResult(delta, "stale", values);
      const boundaryAdmission = this.admitted(desiredNames);
      const freshActive = this.options.host.getActiveTools();
      const boundaryConfigured = this.configured();
      this.reconcileOwnership(boundaryConfigured, values.collisions);
      if (!this.isCurrent(delta)) return frozenResult(delta, "stale", values);
      const boundaryActivate = activate.filter((name) => boundaryAdmission.has(name) && this.owned.has(name));
      const freshOwned = new Set(this.owned.keys());
      const boundaryNext = unique([...freshActive.filter((name) => !freshOwned.has(name)), ...boundaryActivate]);
      try {
        this.options.host.setActiveTools(boundaryNext);
      } catch {
        activeSetFailed = true;
        values.failures.push("active-set");
      }
      this.reconcileOwnership(this.configured(), values.collisions);
      const observed = this.options.host.getActiveTools();
      for (const name of boundaryActivate) {
        if (!freshActive.includes(name) && observed.includes(name) && this.owned.has(name)) values.activated.push(name);
      }
      for (const name of freshActive) {
        if (freshOwned.has(name) && !boundaryActivate.includes(name) && !observed.includes(name)) values.deactivated.push(name);
      }
      if (this.isCurrent(delta)) {
        const postAdmission = this.admitted(desiredNames);
        const permissionRevoked = boundaryActivate.filter((name) => !postAdmission.has(name));
        for (const name of permissionRevoked) values.denied.push(name);
        await this.compensateNewRegistrations(permissionRevoked, values);
      }
      if (!this.isCurrent(delta)) {
        const staleAdds = boundaryActivate.filter((name) => !freshActive.includes(name));
        await this.compensateNewRegistrations(staleAdds, values);
        return frozenResult(delta, "stale", values);
      }
    }

    if (activeSetFailed) {
      await this.compensateNewRegistrations(values.registered, values);
      return frozenResult(delta, "failed", values);
    }

    try {
      if (!this.isCurrent(delta)) return frozenResult(delta, "stale", values);
      this.promptStore.refresh(
        [...this.catalogs.values()].flatMap((catalog) => catalog.prompts.map((entry) => entry.info)),
      );
    } catch {
      values.failures.push("prompt-catalog");
      return frozenResult(delta, "failed", values);
    }
    return frozenResult(delta, values.failures.length === 0 ? "applied" : "failed", values);
  }

  private desiredTools(): { desired: Map<string, DesiredTool>; ambiguous: Set<string> } {
    const candidates = new Map<string, DesiredTool[]>();
    const add = (name: string, entry: DesiredTool): void => {
      const values = candidates.get(name) ?? [];
      values.push(entry);
      candidates.set(name, values);
    };

    for (const catalog of this.catalogs.values()) {
      for (const tool of catalog.tools) {
        const name = mcpProxyToolName(tool.info);
        if (!name) continue;
        const definition = buildMcpProxyTool(tool.info, this.options.source);
        if (definition) add(name, { definition, fingerprint: tool.wireDefinitionFingerprint });
      }
    }
    if ([...this.catalogs.values()].some((catalog) => catalog.resourceServer !== undefined)) {
      for (const definition of buildMcpResourceTools(this.options.source, {
        clipMaxTokens: this.options.clipMaxTokens,
        catalogMode: "live",
      })) {
        add(definition.name, {
          definition,
          fingerprint: RESOURCE_DEFINITION_FINGERPRINTS.get(definition.name)!,
        });
      }
    }

    const desired = new Map<string, DesiredTool>();
    const ambiguous = new Set<string>();
    for (const [name, entries] of candidates) {
      if (entries.length === 1) desired.set(name, entries[0]!);
      else ambiguous.add(name);
    }
    return { desired, ambiguous };
  }
}

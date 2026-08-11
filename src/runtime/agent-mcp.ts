import type {
  AgentMcpDeclaration,
  ResolvedAgentMcpConfig,
  ResolvedAgentMcpServer,
} from "../types.js";
import { neutralizeControlChars } from "../util/neutralize-text.js";
import {
  McpRuntime,
  type McpCleanupOutcome,
  type McpResourceServerInfo,
  type McpRuntimeDeps,
  type McpServerState,
  type McpToolInfo,
} from "./mcp.js";
import { ListMcpResourcesTool, ReadMcpResourceTool } from "./mcp-resources.js";
import { mcpProxyToolName } from "./mcp-tools.js";

const DIAGNOSTIC_LIMIT = 128;
const DIAGNOSTIC_CHARS = 512;
const IDENTITY_CHARS = 200;

export interface AgentMcpRuntimeSource {
  whenSettled(): Promise<void>;
  tools(): McpToolInfo[];
  resourceServers(): McpResourceServerInfo[];
  serverStates(): McpServerState[];
  callTool(serverName: string, toolName: string, args: unknown): Promise<unknown>;
  readResource(serverName: string, uri: string): Promise<unknown>;
}

export interface OwnedAgentMcpRuntime extends AgentMcpRuntimeSource {
  diagnostics?(): string[];
  shutdown(): Promise<void>;
  shutdownAgent?(): Promise<McpCleanupOutcome>;
  retryAgentShutdown?(serverNames: readonly string[]): Promise<McpCleanupOutcome>;
}

export type AgentMcpSetupOutcomeKind =
  | "missing-reference"
  | "inline-startup-failed";

export interface AgentMcpSetupOutcome {
  readonly serverName: string;
  readonly kind: AgentMcpSetupOutcomeKind;
}

export interface AgentMcpScope extends AgentMcpRuntimeSource {
  diagnostics(): readonly string[];
  setupOutcomes(): readonly AgentMcpSetupOutcome[];
  knownToolNames(): readonly string[];
  /** Settled identities routed through the already-published session runtime. */
  borrowedServerNames?(): readonly string[];
  /** Live, published stdio servers owned by this scope; safe identities only. */
  activeOwnedStdioServerNames?(): readonly string[];
  shutdown(): Promise<McpCleanupOutcome>;
  retryUnconfirmedShutdown(): Promise<McpCleanupOutcome>;
}

export interface CreateAgentMcpScopeOptions {
  readonly sessionRuntime: AgentMcpRuntimeSource;
  readonly declaration?: Pick<AgentMcpDeclaration, "items"> &
    Partial<Pick<AgentMcpDeclaration, "diagnostics">>;
  readonly inlineConfig: ResolvedAgentMcpConfig;
  readonly inlineDeps: McpRuntimeDeps;
  readonly startInline?: (
    config: ResolvedAgentMcpConfig,
    deps: McpRuntimeDeps,
  ) => OwnedAgentMcpRuntime;
  /** Generation cancellation; startup never outlives its dispatch owner. */
  readonly signal?: AbortSignal;
}

type RouteSource = "session" | "inline";
type Route = { readonly kind: RouteSource; readonly source: AgentMcpRuntimeSource };

/**
 * Settles the borrowed session catalog, starts only non-colliding admitted inline servers, and
 * publishes one dispatch-local immutable capability scope. It never registers capabilities globally.
 */
export async function createAgentMcpScope(
  options: CreateAgentMcpScopeOptions,
): Promise<AgentMcpScope> {
  await abortable(options.sessionRuntime.whenSettled(), options.signal);

  const sessionTools = options.sessionRuntime.tools();
  const sessionResources = options.sessionRuntime.resourceServers();
  const sessionStates = options.sessionRuntime.serverStates();
  const sessionNames = new Set([
    ...sessionStates.filter(isPublishedState).map((state) => state.name),
    ...sessionTools.map((entry) => entry.serverName),
    ...sessionResources.map((entry) => entry.serverName),
  ]);
  const declarationItems = options.declaration?.items ?? [];
  // Omission and a genuinely clean empty list inherit. An explicitly malformed
  // declaration with no valid survivors must not widen into the session universe.
  const inheritAll = options.declaration === undefined ||
    (declarationItems.length === 0 && (options.declaration.diagnostics?.length ?? 0) === 0);
  const selectedSessionNames = new Set<string>();
  const diagnostics: string[] = [];
  const outcomes: AgentMcpSetupOutcome[] = [];

  if (inheritAll) {
    for (const name of sessionNames) selectedSessionNames.add(name);
  } else {
    const seenReferences = new Set<string>();
    for (const item of declarationItems) {
      if (item.kind !== "reference" || seenReferences.has(item.name)) continue;
      seenReferences.add(item.name);
      if (sessionNames.has(item.name)) {
        selectedSessionNames.add(item.name);
      } else {
        retainOutcome(outcomes, item.name, "missing-reference");
        diagnostics.push(`Agent MCP reference ${quotedSafeName(item.name)} is unavailable.`);
      }
    }
  }

  const retainedInline: ResolvedAgentMcpServer[] = [];
  for (const server of options.inlineConfig.servers) {
    if (sessionNames.has(server.name)) {
      // Session-wins is the successful collision rule: borrow the published
      // session server and neither start nor warn about the duplicate inline item.
      selectedSessionNames.add(server.name);
      continue;
    }
    retainedInline.push(server);
  }

  const inlineConfig: ResolvedAgentMcpConfig = {
    servers: Object.freeze(retainedInline),
    diagnostics: options.inlineConfig.diagnostics,
    diagnosticOwnership: options.inlineConfig.diagnosticOwnership,
  };
  const hasEnabledInline = retainedInline.some((server) => server.status === "enabled");
  let setupAbortCleanup: McpCleanupOutcome | undefined;
  const owned = hasEnabledInline
    ? (options.startInline ?? McpRuntime.startAgent)(inlineConfig, options.inlineDeps)
    : undefined;
  if (owned) {
    try {
      await abortable(owned.whenSettled(), options.signal);
    } catch (error) {
      if (!options.signal?.aborted) {
        await owned.shutdown().catch(() => undefined);
        throw error;
      }
      setupAbortCleanup = owned.shutdownAgent
        ? freezeCleanupOutcome(await owned.shutdownAgent())
        : await owned.shutdown().then(emptyCleanupOutcome);
    }
  }

  const routes = new Map<string, Route>();
  for (const name of selectedSessionNames) routes.set(name, { kind: "session", source: options.sessionRuntime });
  const inlineTools = owned?.tools() ?? [];
  const inlineResources = owned?.resourceServers() ?? [];
  const inlineStates = owned?.serverStates() ?? [];
  const publishedInlineNames = new Set([
    ...inlineStates.filter(isPublishedState).map((state) => state.name),
    // Retained catalogs are publication evidence even when the remote server is now terminally
    // failed. Routing membership must remain immutable so calls reach the runtime's live error.
    ...inlineTools.map((entry) => entry.serverName),
    ...inlineResources.map((entry) => entry.serverName),
  ]);
  if (owned) {
    for (const name of publishedInlineNames) {
      if (!routes.has(name)) routes.set(name, { kind: "inline", source: owned });
    }
  }

  const enabledInlineNames = new Set(retainedInline
    .filter((server) => server.status === "enabled")
    .map((server) => server.name));
  const failedOwnedNames = new Set(inlineStates
    .filter((state) => enabledInlineNames.has(state.name) && !publishedInlineNames.has(state.name))
    .map((state) => state.name));
  for (const name of failedOwnedNames) {
    retainOutcome(outcomes, name, "inline-startup-failed");
    diagnostics.push(`Agent MCP inline server ${quotedSafeName(name)} failed during startup or discovery.`);
  }
  // Owned diagnostics are represented only by identity and fixed failure classes. Runtime prose can
  // contain stderr, expanded config, or raw errors and therefore must not cross into the agent scope.
  if (owned?.diagnostics && owned.diagnostics().length > 0) {
    diagnostics.push("Agent MCP runtime produced additional redacted diagnostics.");
  }

  const inlineNames = inlineRouteNames(routes);
  const tools = immutableSnapshot([
    ...filterTools(sessionTools, selectedSessionNames),
    ...filterTools(inlineTools, inlineNames),
  ]);
  const resourceServers = immutableSnapshot([
    ...filterResourceServers(sessionResources, selectedSessionNames),
    ...filterResourceServers(inlineResources, inlineNames),
  ]);
  const knownToolNames = Object.freeze([
    ...tools.map(mcpProxyToolName).filter((name): name is string => name !== undefined),
    ...(resourceServers.length > 0 ? [ListMcpResourcesTool, ReadMcpResourceTool] : []),
  ]);
  const visibleAdmissionDiagnostics = options.inlineConfig.diagnostics.filter((_diagnostic, index) => {
    const owner = options.inlineConfig.diagnosticOwnership[index];
    return owner?.kind !== "server" || !sessionNames.has(owner.serverName);
  });
  const safeDiagnostics = Object.freeze(boundDiagnostics([
    ...visibleAdmissionDiagnostics.map(() => "An admitted agent MCP definition produced a redacted setup diagnostic."),
    ...diagnostics,
  ]));
  const ownedStdioNames = new Set(retainedInline
    .filter((server) => server.status === "enabled" && server.transport === "stdio")
    .map((server) => server.name));
  const setupOutcomes = immutableSnapshot(outcomes.slice(0, DIAGNOSTIC_LIMIT));

  let shuttingDown = false;
  let shutdownPromise: Promise<McpCleanupOutcome> | undefined;
  let unconfirmed: readonly string[] = Object.freeze([]);
  let retryPromise: Promise<McpCleanupOutcome> | undefined;
  let generation = 0;

  const routed = async (
    serverName: string,
    operation: (source: AgentMcpRuntimeSource) => Promise<unknown>,
  ): Promise<unknown> => {
    if (shuttingDown) throw new Error("Agent MCP scope is shut down");
    const route = routes.get(serverName);
    if (!route) throw new Error(`MCP server ${quotedSafeName(serverName)} is not available in this agent scope`);
    const callGeneration = generation;
    const result = await operation(route.source);
    if (shuttingDown || generation !== callGeneration) throw new Error("Agent MCP scope was shut down during the operation");
    return result;
  };

  const startShutdown = (): Promise<McpCleanupOutcome> => {
    if (shutdownPromise) return shutdownPromise;
    shuttingDown = true;
    generation += 1;
    shutdownPromise = (async () => {
      if (!owned) return emptyCleanupOutcome();
      if (setupAbortCleanup) {
        unconfirmed = setupAbortCleanup.unconfirmed;
        return setupAbortCleanup;
      }
      const outcome = owned.shutdownAgent
        ? await owned.shutdownAgent()
        : await owned.shutdown().then(emptyCleanupOutcome);
      unconfirmed = outcome.unconfirmed;
      return freezeCleanupOutcome(outcome);
    })();
    return shutdownPromise;
  };

  return Object.freeze({
    whenSettled: async () => {},
    tools: () => tools as unknown as McpToolInfo[],
    resourceServers: () => resourceServers as unknown as McpResourceServerInfo[],
    serverStates: () => immutableSnapshot(projectLiveStates(
      routes,
      failedOwnedNames,
      options.sessionRuntime,
      owned,
    )) as unknown as McpServerState[],
    diagnostics: () => safeDiagnostics,
    setupOutcomes: () => setupOutcomes,
    knownToolNames: () => knownToolNames,
    borrowedServerNames: () => Object.freeze([...routes.entries()]
      .filter(([, route]) => route.kind === "session")
      .map(([name]) => safeName(name))),
    activeOwnedStdioServerNames: () => Object.freeze((owned?.serverStates() ?? [])
      .filter((state) => state.state === "connected" && ownedStdioNames.has(state.name) && routes.get(state.name)?.kind === "inline")
      .map((state) => safeName(state.name))),
    callTool: (serverName: string, toolName: string, args: unknown) =>
      routed(serverName, (source) => source.callTool(serverName, toolName, args)),
    readResource: (serverName: string, uri: string) =>
      routed(serverName, (source) => source.readResource(serverName, uri)),
    shutdown: startShutdown,
    retryUnconfirmedShutdown: () => {
      retryPromise ??= (async () => {
        await startShutdown();
        if (!owned || unconfirmed.length === 0 || !owned.retryAgentShutdown) {
          return unconfirmed.length === 0 ? emptyCleanupOutcome() : freezeCleanupOutcome({
            confirmed: [],
            unconfirmed,
            diagnostics: [],
          });
        }
        const outcome = freezeCleanupOutcome(await owned.retryAgentShutdown(unconfirmed));
        unconfirmed = outcome.unconfirmed;
        return outcome;
      })();
      return retryPromise;
    },
  });
}

function projectLiveStates(
  routes: ReadonlyMap<string, Route>,
  failedOwnedNames: ReadonlySet<string>,
  session: AgentMcpRuntimeSource,
  owned: OwnedAgentMcpRuntime | undefined,
): McpServerState[] {
  const sessionStates = new Map(session.serverStates().map((state) => [state.name, state]));
  const ownedStates = new Map((owned?.serverStates() ?? []).map((state) => [state.name, state]));
  const projected: McpServerState[] = [];
  for (const [name, route] of routes) {
    const state = (route.kind === "session" ? sessionStates : ownedStates).get(name);
    if (state) projected.push(safeStateProjection(state, route.kind));
  }
  for (const name of failedOwnedNames) {
    if (!routes.has(name)) {
      const state = ownedStates.get(name);
      if (state) projected.push(safeStateProjection(state, "inline", true));
    }
  }
  return projected;
}

function safeStateProjection(
  state: McpServerState,
  source: RouteSource,
  neverPublishedInline = false,
): McpServerState {
  const statusSummary = source === "inline"
    ? ownedStatusSummary(state.state, neverPublishedInline)
    : state.statusSummary === undefined ? undefined : boundSafeStatus(state.statusSummary);
  return {
    name: safeName(state.name),
    transport: state.transport,
    state: state.state,
    ...(state.attempt !== undefined ? { attempt: state.attempt } : {}),
    ...(state.attemptLimit !== undefined ? { attemptLimit: state.attemptLimit } : {}),
    ...(state.toolsAdvertised !== undefined ? { toolsAdvertised: state.toolsAdvertised } : {}),
    ...(state.promptsAdvertised !== undefined ? { promptsAdvertised: state.promptsAdvertised } : {}),
    ...(state.resourcesAdvertised !== undefined ? { resourcesAdvertised: state.resourcesAdvertised } : {}),
    ...(state.toolCount !== undefined ? { toolCount: state.toolCount } : {}),
    ...(state.promptCount !== undefined ? { promptCount: state.promptCount } : {}),
    ...(state.resourceCount !== undefined ? { resourceCount: state.resourceCount } : {}),
    ...(state.initialToolDiscoveryFailed === true ? { initialToolDiscoveryFailed: true as const } : {}),
    ...(statusSummary !== undefined ? { statusSummary } : {}),
  };
}

function ownedStatusSummary(state: McpServerState["state"], neverPublished: boolean): string {
  if (neverPublished) {
    return "Agent MCP server failed during startup or discovery. Review the server configuration and logs, then restart the agent.";
  }
  switch (state) {
    case "connecting": return "Agent MCP server startup is in progress.";
    case "connected": return "Agent MCP server is connected.";
    case "retrying":
    case "reconnecting": return "Agent MCP server recovery is in progress.";
    case "failed": return "Previously published agent MCP capabilities are unavailable. Review the server configuration and logs, then restart the agent.";
  }
}

function boundSafeStatus(value: string): string {
  const safe = neutralizeControlChars(value);
  return safe.length > DIAGNOSTIC_CHARS ? `${safe.slice(0, DIAGNOSTIC_CHARS - 1)}…` : safe;
}

function isPublishedState(state: McpServerState): boolean {
  return state.state === "connected" || state.toolsAdvertised === true ||
    state.promptsAdvertised === true || state.resourcesAdvertised === true;
}

function inlineRouteNames(routes: ReadonlyMap<string, Route>): ReadonlySet<string> {
  return new Set([...routes].filter(([, route]) => route.kind === "inline").map(([name]) => name));
}

function filterTools(source: readonly McpToolInfo[], names: ReadonlySet<string>): McpToolInfo[] {
  return source.filter((tool) => names.has(tool.serverName));
}

function filterResourceServers(
  source: readonly McpResourceServerInfo[],
  names: ReadonlySet<string>,
): McpResourceServerInfo[] {
  return source.filter((server) => names.has(server.serverName));
}

function retainOutcome(
  outcomes: AgentMcpSetupOutcome[],
  serverName: string,
  kind: AgentMcpSetupOutcomeKind,
): void {
  if (outcomes.length >= DIAGNOSTIC_LIMIT) return;
  outcomes.push({ serverName: safeName(serverName), kind });
}

function safeName(value: string): string {
  return neutralizeControlChars(value).slice(0, IDENTITY_CHARS);
}

function quotedSafeName(value: string): string {
  return JSON.stringify(safeName(value));
}

function boundDiagnostics(messages: readonly string[]): string[] {
  const retained = messages.slice(0, DIAGNOSTIC_LIMIT - 1).map((message) => {
    const safe = neutralizeControlChars(message);
    return safe.length > DIAGNOSTIC_CHARS ? `${safe.slice(0, DIAGNOSTIC_CHARS - 1)}…` : safe;
  });
  if (messages.length >= DIAGNOSTIC_LIMIT) retained.push("Additional agent MCP diagnostics were omitted.");
  return retained;
}

function immutableSnapshot<T>(value: T): T {
  return deepFreeze(cloneValue(value));
}

function cloneValue<T>(value: T, seen = new Map<object, unknown>()): T {
  if (typeof value !== "object" || value === null) return value;
  const prior = seen.get(value);
  if (prior !== undefined) return prior as T;
  const clone: unknown[] | Record<PropertyKey, unknown> = Array.isArray(value)
    ? []
    : Object.create(Object.getPrototypeOf(value) === null ? null : Object.prototype);
  seen.set(value, clone);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor?.enumerable) {
      Object.defineProperty(clone, key, {
        value: cloneValue((value as Record<PropertyKey, unknown>)[key], seen),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
  }
  return clone as T;
}

function deepFreeze<T>(value: T, seen = new Set<object>()): T {
  if (typeof value !== "object" || value === null || seen.has(value)) return value;
  seen.add(value);
  for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested, seen);
  return Object.freeze(value);
}

async function abortable<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) throw new Error("Agent MCP setup aborted");
  let rejectAbort!: (error: Error) => void;
  const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
  const onAbort = () => rejectAbort(new Error("Agent MCP setup aborted"));
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    return await Promise.race([promise, aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

function emptyCleanupOutcome(): McpCleanupOutcome {
  return Object.freeze({ confirmed: Object.freeze([]), unconfirmed: Object.freeze([]), diagnostics: Object.freeze([]) });
}

function freezeCleanupOutcome(outcome: McpCleanupOutcome): McpCleanupOutcome {
  const unconfirmed = Object.freeze([...outcome.unconfirmed].map(safeName));
  return Object.freeze({
    confirmed: Object.freeze([...outcome.confirmed].map(safeName)),
    unconfirmed,
    diagnostics: Object.freeze(unconfirmed.length === 0
      ? []
      : [`Cleanup could not be confirmed for ${unconfirmed.length} agent MCP server(s).`]),
  });
}

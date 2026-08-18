import type {
  McpAdministrationInventory,
  McpAdministrationInventoryItem,
  McpAdministrationLiveState,
  McpAdministrationTrace,
} from "./model.js";

export const MCP_ADMINISTRATION_INVENTORY_LIMITS = Object.freeze({ servers: 512, capabilityCount: 1_000_000 });

function boundedCount(value: number | undefined): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? Math.min(value, MCP_ADMINISTRATION_INVENTORY_LIMITS.capabilityCount)
    : 0;
}

function liveKey(state: Pick<McpAdministrationLiveState, "name" | "agentOwner">): string {
  return `${state.agentOwner?.scope ?? "ordinary"}\u0000${state.agentOwner?.name ?? ""}\u0000${state.name}`;
}

export function createMcpAdministrationInventory(
  trace: McpAdministrationTrace,
  liveStates: readonly McpAdministrationLiveState[] = [],
): McpAdministrationInventory {
  const liveByKey = new Map<string, McpAdministrationLiveState>();
  for (const state of liveStates.slice(0, MCP_ADMINISTRATION_INVENTORY_LIMITS.servers)) {
    if (!liveByKey.has(liveKey(state))) liveByKey.set(liveKey(state), state);
  }
  const servers: McpAdministrationInventoryItem[] = [];
  for (const declaration of trace.declarations.slice(0, MCP_ADMINISTRATION_INVENTORY_LIMITS.servers)) {
    const live = declaration.precedence === "winner" ? liveByKey.get(liveKey(declaration)) : undefined;
    const summary = Object.freeze({
      ...(declaration.summary.transport === undefined ? {} : { transport: declaration.summary.transport }),
      ...(declaration.summary.configuredType === undefined ? {} : { configuredType: declaration.summary.configuredType }),
      ...(declaration.summary.commandBasename === undefined ? {} : { commandBasename: declaration.summary.commandBasename }),
      ...(declaration.summary.remoteOrigin === undefined ? {} : { remoteOrigin: declaration.summary.remoteOrigin }),
      argumentCount: declaration.summary.argumentCount,
      environmentKeyCount: declaration.summary.environmentKeyCount,
      headerKeyCount: declaration.summary.headerKeyCount,
      timeoutConfigured: declaration.summary.timeoutConfigured,
    });
    const authority = declaration.authority.kind === "mutable"
      ? Object.freeze({ kind: "mutable" as const, scope: declaration.authority.scope })
      : Object.freeze({ kind: "read-only" as const, sourceClass: declaration.authority.sourceClass });
    servers.push(Object.freeze({
      name: declaration.name,
      source: declaration.source,
      ...(declaration.agentOwner === undefined ? {} : { agentOwner: Object.freeze({ ...declaration.agentOwner }) }),
      authority,
      precedence: declaration.precedence,
      summary,
      policy: declaration.policy,
      review: declaration.review,
      status: declaration.status,
      ...(declaration.inactiveReason === undefined ? {} : { inactiveReason: declaration.inactiveReason }),
      live: live?.state ?? "not-running",
      capabilityCounts: Object.freeze({
        tools: boundedCount(live?.toolCount),
        prompts: boundedCount(live?.promptCount),
        resources: boundedCount(live?.resourceCount),
      }),
    }));
  }
  const additionallyOmitted = Math.max(0, trace.declarations.length - servers.length);
  const omittedDeclarationCount = trace.omittedDeclarationCount + additionallyOmitted;
  const observations = omittedDeclarationCount > 0 && !trace.observations.includes("administration-declarations-omitted")
    ? [...trace.observations, "administration-declarations-omitted" as const]
    : [...trace.observations];
  return Object.freeze({
    version: 1,
    policyPosture: trace.policyPosture,
    observations: Object.freeze(observations),
    ...(trace.remediation === undefined ? {} : { remediation: trace.remediation }),
    servers: Object.freeze(servers),
    omittedDeclarationCount,
  });
}

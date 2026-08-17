import type { ResolvedMcpConfig } from "../types.js";
import { createMcpAdministrationInventory } from "./inventory.js";
import type {
  McpAdministrationDeclaration,
  McpAdministrationInventory,
  McpAdministrationLiveState,
  McpAgentOwner,
  McpMutationScope,
  McpReviewDecision,
  McpReviewRecord,
} from "./model.js";
import {
  bindMcpDeclarationDefinition,
  mcpPersistenceDeclarationEvidence,
  type McpDeclarationDefinitionBinding,
  type McpPendingOperationProjection,
  type McpPersistenceMutation,
  type McpPersistenceResult,
} from "./persistence.js";

export type McpAdministrationAction =
  | { readonly kind: "add"; readonly scope: McpMutationScope; readonly name: string; readonly definition: Readonly<Record<string, unknown>> }
  | { readonly kind: "remove"; readonly scope: McpMutationScope; readonly name: string }
  | { readonly kind: "reset-project-choices" }
  | { readonly kind: "approve" | "reject" | "disable" | "enable" | "reconnect" | "authenticate"; readonly name: string; readonly agentOwner?: McpAgentOwner };

export type McpAdministrationLiveAction =
  | { readonly kind: "add" | "remove"; readonly scope: McpMutationScope; readonly name: string }
  | { readonly kind: "reset-project-choices" }
  | { readonly kind: "approve" | "reject" | "disable" | "enable" | "reconnect"; readonly name: string; readonly agentOwner?: McpAgentOwner };

export type McpAdministrationReasonCode =
  | "eligible"
  | "recovery-pending"
  | "cleanup-pending"
  | "already-exists"
  | "server-not-found"
  | "scope-mismatch"
  | "unsupported-source"
  | "policy-blocked"
  | "review-not-applicable"
  | "compatibility-rejected"
  | "definition-unavailable"
  | "invalid-input"
  | "stale-state"
  | "not-effective"
  | "not-disabled"
  | "not-enabled"
  | "not-failed"
  | "unsupported-transport"
  | "authentication-deferred"
  | "authentication-unavailable"
  | "durable-mutation-failed";

export interface McpAdministrationEligibility {
  readonly eligible: boolean;
  readonly reasonCode: McpAdministrationReasonCode;
}

export type McpAdministrationOperationReasonCode =
  | "runtime-failed"
  | "exposure-failed"
  | "generation-stale"
  | "server-unavailable"
  | "live-port-failure";

export type McpAdministrationOperationOutcome =
  | { readonly state: "not-requested" }
  | { readonly state: "succeeded" }
  | { readonly state: "failed"; readonly reasonCode: McpAdministrationOperationReasonCode };

export interface McpAdministrationFreshState {
  readonly mcp: ResolvedMcpConfig;
  readonly reviewIdentity: {
    readonly profileKey: string;
    readonly checkoutFamilyKey: string;
  };
  readonly liveStates?: readonly McpAdministrationLiveState[];
}

export interface McpAdministrationActivationAdmissionBinding {
  readonly admittedName: string;
  readonly admittedSource: McpAdministrationDeclaration["source"];
  readonly admittedAgentOwner?: Readonly<McpAgentOwner>;
  readonly admittedDefinitionVersion: 1;
  readonly admittedDefinitionDigest: string;
  readonly admittedPolicy: "allowed";
  readonly admittedStatus: "enabled";
  readonly admittedProfileKey: string;
  readonly admittedCheckoutFamilyKey: string;
}

export interface McpAdministrationLiveRequest {
  readonly action: McpAdministrationLiveAction;
  readonly before: McpAdministrationInventory;
  readonly after: McpAdministrationInventory;
  readonly activationAdmissionBinding?: McpAdministrationActivationAdmissionBinding;
}

export interface McpAdministrationLiveResult {
  readonly runtime: McpAdministrationOperationOutcome;
  readonly exposure: McpAdministrationOperationOutcome;
}

export interface McpAdministrationLivePort {
  apply(request: McpAdministrationLiveRequest): Promise<McpAdministrationLiveResult>;
}

export interface McpAdministrationServiceDependencies {
  inspectPending(): Promise<McpPendingOperationProjection>;
  recover(): Promise<McpPersistenceResult>;
  mutate(mutation: McpPersistenceMutation): Promise<McpPersistenceResult>;
  assemble(): McpAdministrationFreshState | Promise<McpAdministrationFreshState>;
  readonly live?: McpAdministrationLivePort;
}

export interface McpAdministrationPreview {
  readonly inventory: McpAdministrationInventory;
  readonly eligibility: McpAdministrationEligibility;
}

export interface McpAdministrationRecoveryPreparation extends McpAdministrationPreview {
  readonly recovery: McpPersistenceResult | { readonly state: "not-requested" };
}

export interface McpAdministrationResult extends McpAdministrationPreview {
  readonly recovery: McpPersistenceResult | { readonly state: "not-requested" };
  readonly durable: McpPersistenceResult | { readonly state: "not-requested" };
  readonly runtime: McpAdministrationOperationOutcome;
  readonly exposure: McpAdministrationOperationOutcome;
}

const NOT_REQUESTED = Object.freeze({ state: "not-requested" as const });
const RECOVERY_BLOCKED_INVENTORY: McpAdministrationInventory = Object.freeze({
  version: 1,
  policyPosture: "fail-closed",
  observations: Object.freeze(["administration-recovery-pending" as const]),
  remediation: "administration-recovery-pending",
  servers: Object.freeze([]),
  omittedDeclarationCount: 0,
});
const PROJECT_REVIEW_SOURCES = new Set(["project-mcpjson", "settings-project", "subagent-inline"] as const);
const PERSISTENT_TOGGLE_SOURCES = new Set(["native-local", "project-mcpjson", "native-user"] as const);
const SOURCE_FOR_SCOPE: Readonly<Record<McpMutationScope, McpAdministrationDeclaration["source"]>> = Object.freeze({
  local: "native-local", project: "project-mcpjson", user: "native-user",
});

function inventoryOf(state: McpAdministrationFreshState): McpAdministrationInventory {
  return createMcpAdministrationInventory(state.mcp.administration ?? Object.freeze({
    version: 1,
    policyPosture: state.mcp.policyPosture ?? "absent",
    observations: Object.freeze([]),
    declarations: Object.freeze([]),
    omittedDeclarationCount: 0,
  }), state.liveStates);
}

function sameOwner(left: McpAgentOwner | undefined, right: McpAgentOwner | undefined): boolean {
  return left?.name === right?.name && left?.scope === right?.scope;
}

function winner(inventory: McpAdministrationInventory, name: string, owner?: McpAgentOwner): McpAdministrationInventory["servers"][number] | undefined {
  return inventory.servers.find((server) => server.name === name && server.precedence === "winner" && sameOwner(server.agentOwner, owner));
}

function exactScope(inventory: McpAdministrationInventory, name: string, scope: McpMutationScope) {
  return inventory.servers.find((server) => server.name === name && server.authority.kind === "mutable" && server.authority.scope === scope && server.agentOwner === undefined);
}

function denied(reasonCode: McpAdministrationReasonCode): McpAdministrationEligibility {
  return Object.freeze({ eligible: false, reasonCode });
}

function eligible(): McpAdministrationEligibility {
  return Object.freeze({ eligible: true, reasonCode: "eligible" });
}

function privateDeclaration(state: McpAdministrationFreshState, name: string, owner?: McpAgentOwner): McpAdministrationDeclaration | undefined {
  return state.mcp.administration?.declarations.find((item) => item.name === name && item.precedence === "winner" && sameOwner(item.agentOwner, owner));
}

function exactAddedDeclaration(state: McpAdministrationFreshState, action: Extract<McpAdministrationAction, { kind: "add" }>): McpAdministrationDeclaration | undefined {
  return state.mcp.administration?.declarations.find((item) => item.name === action.name && item.agentOwner === undefined && item.source === SOURCE_FOR_SCOPE[action.scope] && item.authority.kind === "mutable" && item.authority.scope === action.scope);
}

function validPrivateDefinition(declaration: McpAdministrationDeclaration | undefined): declaration is McpAdministrationDeclaration & { definitionVersion: 1; definitionDigest: string } {
  return declaration?.definitionVersion === 1 && typeof declaration.definitionDigest === "string" && /^mcp-review-v1:[a-f0-9]{64}$/u.test(declaration.definitionDigest);
}

function actionEligibility(state: McpAdministrationFreshState, inventory: McpAdministrationInventory, action: McpAdministrationAction, addBinding?: McpDeclarationDefinitionBinding): McpAdministrationEligibility {
  if (action.kind === "reset-project-choices") return eligible();
  if (action.kind === "add") {
    if (addBinding === undefined) return denied("invalid-input");
    return exactScope(inventory, action.name, action.scope) === undefined ? eligible() : denied("already-exists");
  }
  if (action.kind === "remove") {
    const exact = exactScope(inventory, action.name, action.scope);
    if (exact === undefined) return denied(inventory.servers.some((server) => server.name === action.name) ? "scope-mismatch" : "server-not-found");
    return eligible();
  }
  if (action.kind === "reconnect" && action.agentOwner !== undefined) return denied("unsupported-source");
  const server = winner(inventory, action.name, action.agentOwner);
  if (server === undefined) return denied("server-not-found");
  if (server.policy !== "allowed" || server.status === "blocked") return denied("policy-blocked");
  if (action.kind === "approve" || action.kind === "reject") {
    if (!PROJECT_REVIEW_SOURCES.has(server.source as never)) return denied("review-not-applicable");
    if (server.review === "not-required" || (server.source === "subagent-inline" && server.agentOwner?.scope !== "project")) return denied("review-not-applicable");
    if (server.review === "rejected-compatibility") return denied("compatibility-rejected");
    if (server.status === "skipped" || server.status === "not-configured") return denied("not-effective");
    if (!validPrivateDefinition(privateDeclaration(state, action.name, action.agentOwner))) return denied("definition-unavailable");
    return eligible();
  }
  if (action.kind === "disable" || action.kind === "enable") {
    if (!PERSISTENT_TOGGLE_SOURCES.has(server.source as never) || action.agentOwner !== undefined) return denied("unsupported-source");
    if (server.review === "pending" || server.review === "rejected-exact" || server.review === "rejected-compatibility") return denied("review-not-applicable");
    if (action.kind === "disable" && server.status !== "enabled") return denied("not-enabled");
    if (action.kind === "enable" && server.inactiveReason !== "native-runtime-disabled") return denied("not-disabled");
    return eligible();
  }
  const remote = server.summary.transport === "http" || server.summary.transport === "sse";
  if (action.kind === "authenticate") return remote ? denied("authentication-deferred") : denied("authentication-unavailable");
  if (server.agentOwner !== undefined) return denied("unsupported-source");
  if (server.summary.transport !== "stdio" && !remote) return denied("unsupported-transport");
  if (server.live !== "failed") return denied("not-failed");
  if (server.status !== "enabled") return denied("not-effective");
  return eligible();
}

function persistenceMutation(state: McpAdministrationFreshState, action: McpAdministrationAction, addBinding?: McpDeclarationDefinitionBinding): McpPersistenceMutation | undefined {
  if (action.kind === "add") return addBinding === undefined ? undefined : { kind: "set-declaration", scope: action.scope, name: action.name, definition: addBinding.definition };
  if (action.kind === "remove") return { kind: "remove-declaration", scope: action.scope, name: action.name };
  if (action.kind === "reset-project-choices") return { kind: "reset-review" };
  if (action.kind === "disable" || action.kind === "enable") return { kind: "set-runtime-disabled", name: action.name, disabled: action.kind === "disable" };
  if (action.kind === "approve" || action.kind === "reject") {
    const declaration = privateDeclaration(state, action.name, action.agentOwner);
    if (!validPrivateDefinition(declaration)) return undefined;
    const decision: McpReviewDecision = action.kind === "approve" ? "approved" : "rejected";
    const record: McpReviewRecord = {
      profileKey: state.reviewIdentity.profileKey,
      checkoutFamilyKey: state.reviewIdentity.checkoutFamilyKey,
      source: declaration.source,
      serverName: declaration.name,
      ...(declaration.agentOwner === undefined ? {} : { agentOwner: declaration.agentOwner }),
      definitionVersion: 1,
      definitionDigest: declaration.definitionDigest,
      decision,
    };
    return { kind: "set-review", record };
  }
  return undefined;
}

function sameDefinition(left: McpAdministrationDeclaration | undefined, right: McpAdministrationDeclaration | undefined): boolean {
  return left !== undefined && right !== undefined && left.source === right.source && sameOwner(left.agentOwner, right.agentOwner) &&
    left.definitionVersion === right.definitionVersion && left.definitionDigest === right.definitionDigest;
}

function postcommitEligibility(
  action: McpAdministrationAction,
  beforeState: McpAdministrationFreshState,
  afterState: McpAdministrationFreshState,
  before: McpAdministrationInventory,
  after: McpAdministrationInventory,
  addBinding?: McpDeclarationDefinitionBinding,
  durable: McpPersistenceResult | { readonly state: "not-requested" } = NOT_REQUESTED,
): McpAdministrationEligibility {
  if (action.kind === "reset-project-choices") return eligible();
  if (action.kind === "remove") return exactScope(after, action.name, action.scope) === undefined ? eligible() : denied("stale-state");
  const afterServer = winner(after, action.name, "agentOwner" in action ? action.agentOwner : undefined);
  if (action.kind === "add") {
    const finalDeclaration = exactAddedDeclaration(afterState, action); const evidence = durable.state === "not-requested" ? undefined : mcpPersistenceDeclarationEvidence(durable);
    const exactVisibleDefinition = finalDeclaration !== undefined && addBinding !== undefined && finalDeclaration.definitionVersion === addBinding.definitionVersion && finalDeclaration.definitionDigest === addBinding.definitionDigest;
    const exactCommittedEvidence = addBinding !== undefined && evidence?.scope === action.scope && evidence.name === action.name && evidence.definitionVersion === addBinding.definitionVersion && evidence.definitionDigest === addBinding.definitionDigest;
    return exactVisibleDefinition || exactCommittedEvidence ? eligible() : denied("stale-state");
  }
  const beforeDeclaration = privateDeclaration(beforeState, action.name, action.agentOwner);
  const afterDeclaration = privateDeclaration(afterState, action.name, action.agentOwner);
  if (!sameDefinition(beforeDeclaration, afterDeclaration)) return denied("stale-state");
  if (afterServer === undefined) return denied("stale-state");
  if (action.kind === "approve") return afterServer.review === "approved-exact" && afterServer.policy === "allowed" && afterServer.status === "enabled" ? eligible() : denied("not-effective");
  if (action.kind === "reject") return afterServer.review === "rejected-exact" && afterServer.status === "disabled" ? eligible() : denied("not-effective");
  if (action.kind === "disable") return afterServer.source === beforeDeclaration?.source && afterServer.inactiveReason === "native-runtime-disabled" && afterServer.status === "disabled" ? eligible() : denied("not-effective");
  if (action.kind === "enable") return afterServer.source === beforeDeclaration?.source && afterServer.policy === "allowed" && afterServer.status === "enabled" ? eligible() : denied("not-effective");
  if (action.kind === "reconnect") return actionEligibility(afterState, after, action);
  return denied("not-effective");
}

function liveAction(action: McpAdministrationAction): McpAdministrationLiveAction {
  if (action.kind === "add" || action.kind === "remove") return Object.freeze({ kind: action.kind, scope: action.scope, name: action.name });
  if (action.kind === "reset-project-choices") return Object.freeze({ kind: action.kind });
  if (action.kind === "authenticate") throw new Error("Authentication has no live action");
  return Object.freeze({ kind: action.kind, name: action.name, ...(action.agentOwner === undefined ? {} : { agentOwner: Object.freeze({ ...action.agentOwner }) }) });
}

function activationAdmissionBinding(action: McpAdministrationAction, state: McpAdministrationFreshState, addBinding?: McpDeclarationDefinitionBinding): McpAdministrationActivationAdmissionBinding | undefined {
  if (action.kind !== "add" && action.kind !== "approve" && action.kind !== "enable" && action.kind !== "reconnect") return undefined;
  const declaration = privateDeclaration(state, action.name, "agentOwner" in action ? action.agentOwner : undefined);
  if (!validPrivateDefinition(declaration) || declaration.policy !== "allowed" || declaration.status !== "enabled" ||
    (action.kind === "add" && (addBinding === undefined || declaration.source !== SOURCE_FOR_SCOPE[action.scope] || declaration.definitionVersion !== addBinding.definitionVersion || declaration.definitionDigest !== addBinding.definitionDigest))) return undefined;
  return Object.freeze({
    admittedName: declaration.name,
    admittedSource: declaration.source,
    ...(declaration.agentOwner === undefined ? {} : { admittedAgentOwner: Object.freeze({ ...declaration.agentOwner }) }),
    admittedDefinitionVersion: declaration.definitionVersion,
    admittedDefinitionDigest: declaration.definitionDigest,
    admittedPolicy: "allowed",
    admittedStatus: "enabled",
    admittedProfileKey: state.reviewIdentity.profileKey,
    admittedCheckoutFamilyKey: state.reviewIdentity.checkoutFamilyKey,
  });
}

function liveRequest(action: McpAdministrationAction, before: McpAdministrationInventory, after: McpAdministrationInventory, afterState: McpAdministrationFreshState, addBinding?: McpDeclarationDefinitionBinding): McpAdministrationLiveRequest {
  const binding = activationAdmissionBinding(action, afterState, addBinding);
  return Object.freeze({ action: liveAction(action), before, after, ...(binding === undefined ? {} : { activationAdmissionBinding: binding }) });
}

export function createMcpAdministrationService(dependencies: McpAdministrationServiceDependencies) {
  const recoverySucceeded = (result: McpPersistenceResult): boolean =>
    result.cleanup === "complete" && (result.state === "rolled-back" || result.state === "committed" && result.effect === "unchanged");

  const prepareInventoryAfterRecovery = async (): Promise<McpAdministrationRecoveryPreparation> => {
    const pending = await dependencies.inspectPending();
    let recovery: McpAdministrationRecoveryPreparation["recovery"] = NOT_REQUESTED;
    if (pending.pending) {
      recovery = await dependencies.recover();
      if (!recoverySucceeded(recovery)) {
        const reason = recovery.state === "pending-recovery" ? "recovery-pending" : recovery.cleanup === "pending" ? "cleanup-pending" : "durable-mutation-failed";
        return Object.freeze({ inventory: RECOVERY_BLOCKED_INVENTORY, eligibility: denied(reason), recovery });
      }
    }
    const finalPending = await dependencies.inspectPending();
    if (finalPending.pending) return Object.freeze({ inventory: RECOVERY_BLOCKED_INVENTORY, eligibility: denied("recovery-pending"), recovery });
    return Object.freeze({ inventory: inventoryOf(await dependencies.assemble()), eligibility: eligible(), recovery });
  };

  const inventory = async (): Promise<McpAdministrationInventory> => {
    const pending = await dependencies.inspectPending();
    return pending.pending ? RECOVERY_BLOCKED_INVENTORY : inventoryOf(await dependencies.assemble());
  };

  const preview = async (action: McpAdministrationAction): Promise<McpAdministrationPreview> => {
    const pending = await dependencies.inspectPending();
    if (pending.pending) return Object.freeze({ inventory: RECOVERY_BLOCKED_INVENTORY, eligibility: denied("recovery-pending") });
    const state = await dependencies.assemble(); const current = inventoryOf(state);
    const addBinding = action.kind === "add" ? bindMcpDeclarationDefinition(action.name, action.definition) : undefined;
    return Object.freeze({ inventory: current, eligibility: actionEligibility(state, current, action, addBinding?.ok ? addBinding.value : undefined) });
  };

  const execute = async (action: McpAdministrationAction): Promise<McpAdministrationResult> => {
    const pending = await dependencies.inspectPending();
    let recovery: McpAdministrationResult["recovery"] = NOT_REQUESTED;
    if (pending.pending) {
      recovery = await dependencies.recover();
      if (!recoverySucceeded(recovery)) {
        const reason = recovery.state === "pending-recovery" ? "recovery-pending" : recovery.cleanup === "pending" ? "cleanup-pending" : "durable-mutation-failed";
        return Object.freeze({ inventory: RECOVERY_BLOCKED_INVENTORY, eligibility: denied(reason), recovery, durable: NOT_REQUESTED, runtime: NOT_REQUESTED, exposure: NOT_REQUESTED });
      }
    }
    if ((await dependencies.inspectPending()).pending) return Object.freeze({ inventory: RECOVERY_BLOCKED_INVENTORY, eligibility: denied("recovery-pending"), recovery, durable: NOT_REQUESTED, runtime: NOT_REQUESTED, exposure: NOT_REQUESTED });
    const beforeState = await dependencies.assemble(); const before = inventoryOf(beforeState);
    const addBindingResult = action.kind === "add" ? bindMcpDeclarationDefinition(action.name, action.definition) : undefined;
    const addBinding = addBindingResult?.ok ? addBindingResult.value : undefined;
    const initialEligibility = actionEligibility(beforeState, before, action, addBinding);
    if (!initialEligibility.eligible) return Object.freeze({ inventory: before, eligibility: initialEligibility, recovery, durable: NOT_REQUESTED, runtime: NOT_REQUESTED, exposure: NOT_REQUESTED });
    const mutation = persistenceMutation(beforeState, action, addBinding);
    let durable: McpAdministrationResult["durable"] = NOT_REQUESTED;
    if (mutation !== undefined) {
      durable = await dependencies.mutate(mutation);
      const afterState = await dependencies.assemble(); const after = inventoryOf(afterState);
      if (durable.state !== "committed") {
        const reason = durable.state === "pending-recovery" ? "recovery-pending" : durable.cleanup === "pending" ? "cleanup-pending" : "durable-mutation-failed";
        return Object.freeze({ inventory: after, eligibility: denied(reason), recovery, durable, runtime: NOT_REQUESTED, exposure: NOT_REQUESTED });
      }
      if (durable.cleanup === "pending") return Object.freeze({ inventory: after, eligibility: denied("cleanup-pending"), recovery, durable, runtime: NOT_REQUESTED, exposure: NOT_REQUESTED });
      const finalEligibility = postcommitEligibility(action, beforeState, afterState, before, after, addBinding, durable);
      if (!finalEligibility.eligible) return Object.freeze({ inventory: after, eligibility: finalEligibility, recovery, durable, runtime: NOT_REQUESTED, exposure: NOT_REQUESTED });
      if (durable.effect === "unchanged" || dependencies.live === undefined || action.kind === "authenticate" || action.kind === "add" && activationAdmissionBinding(action, afterState, addBinding) === undefined) return Object.freeze({ inventory: after, eligibility: finalEligibility, recovery, durable, runtime: NOT_REQUESTED, exposure: NOT_REQUESTED });
      try {
        const live = await dependencies.live.apply(liveRequest(action, before, after, afterState, addBinding));
        return Object.freeze({ inventory: after, eligibility: finalEligibility, recovery, durable, runtime: live.runtime, exposure: live.exposure });
      } catch {
        return Object.freeze({ inventory: after, eligibility: finalEligibility, recovery, durable, runtime: Object.freeze({ state: "failed" as const, reasonCode: "live-port-failure" }), exposure: NOT_REQUESTED });
      }
    }
    const afterState = await dependencies.assemble(); const after = inventoryOf(afterState);
    const finalEligibility = postcommitEligibility(action, beforeState, afterState, before, after, addBinding);
    if (!finalEligibility.eligible || dependencies.live === undefined || action.kind === "authenticate") return Object.freeze({ inventory: after, eligibility: finalEligibility, recovery, durable, runtime: NOT_REQUESTED, exposure: NOT_REQUESTED });
    try {
      const live = await dependencies.live.apply(liveRequest(action, before, after, afterState));
      return Object.freeze({ inventory: after, eligibility: finalEligibility, recovery, durable, runtime: live.runtime, exposure: live.exposure });
    } catch {
      return Object.freeze({ inventory: after, eligibility: finalEligibility, recovery, durable, runtime: Object.freeze({ state: "failed" as const, reasonCode: "live-port-failure" }), exposure: NOT_REQUESTED });
    }
  };

  return Object.freeze({ inventory, prepareInventoryAfterRecovery, preview, execute });
}

export type McpAdministrationService = ReturnType<typeof createMcpAdministrationService>;

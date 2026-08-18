import type { EnabledRemoteMcpServer, EnabledStdioMcpServer, ResolvedMcpConfig } from "../types.js";
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

const MCP_RUNTIME_ADMISSION_BRAND: unique symbol = Symbol("picc.mcp-runtime-admission");

/** Opaque, non-serializable authority minted only from one exact fresh service assembly. */
export interface McpAdministrationRuntimeAdmission {
  readonly [MCP_RUNTIME_ADMISSION_BRAND]: true;
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

export interface McpAdministrationRuntimeAdmissionContents {
  readonly server: EnabledStdioMcpServer | EnabledRemoteMcpServer;
  readonly binding: McpAdministrationActivationAdmissionBinding;
}

const runtimeAdmissions = new WeakMap<object, McpAdministrationRuntimeAdmissionContents>();

/** Runtime-side authenticity check; arbitrary objects and copied envelopes fail closed. */
export function openMcpAdministrationRuntimeAdmission(
  admission: McpAdministrationRuntimeAdmission,
): McpAdministrationRuntimeAdmissionContents | undefined {
  return typeof admission === "object" && admission !== null ? runtimeAdmissions.get(admission) : undefined;
}

const MCP_RUNTIME_TRANSITION_BRAND: unique symbol = Symbol("picc.mcp-runtime-transition");

/** Opaque service-minted change in the ownerless effective runtime winner. */
export interface McpAdministrationRuntimeTransition {
  readonly [MCP_RUNTIME_TRANSITION_BRAND]: true;
}

export type McpAdministrationRuntimeTransitionContents =
  | { readonly kind: "retire"; readonly serverName: string }
  | { readonly kind: "activate"; readonly admission: McpAdministrationRuntimeAdmission }
  | { readonly kind: "replace"; readonly serverName: string; readonly admission: McpAdministrationRuntimeAdmission }
  | { readonly kind: "reconnect"; readonly admission: McpAdministrationRuntimeAdmission };

const runtimeTransitions = new WeakMap<object, McpAdministrationRuntimeTransitionContents>();

/** Runtime-side authenticity check; copied or freely assembled transitions fail closed. */
export function openMcpAdministrationRuntimeTransition(
  transition: McpAdministrationRuntimeTransition,
): McpAdministrationRuntimeTransitionContents | undefined {
  return typeof transition === "object" && transition !== null ? runtimeTransitions.get(transition) : undefined;
}

export interface McpAdministrationLiveRequest {
  readonly action: McpAdministrationLiveAction;
  readonly transitions: readonly McpAdministrationRuntimeTransition[];
  readonly runtimeAdmission?: McpAdministrationRuntimeAdmission;
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

export type McpAdministrationInteractiveAction = Extract<McpAdministrationAction, {
  readonly kind: "approve" | "reject" | "disable" | "enable" | "reconnect" | "authenticate";
}>["kind"];

export interface McpAdministrationInteractiveSelector {
  readonly name: string;
  readonly source: McpAdministrationDeclaration["source"];
  readonly authority: McpAdministrationDeclaration["authority"];
  readonly precedence: McpAdministrationDeclaration["precedence"];
  readonly agentOwner?: Readonly<McpAgentOwner>;
}

const MCP_CONFIRMATION_AUTHORITY_BRAND: unique symbol = Symbol("picc.mcp-confirmation-authority");

/** Service-local authority for one exact interactive confirmation. */
export interface McpAdministrationConfirmationAuthority {
  readonly [MCP_CONFIRMATION_AUTHORITY_BRAND]: true;
}

export interface McpAdministrationInteractivePreparation extends McpAdministrationPreview {
  readonly authority?: McpAdministrationConfirmationAuthority;
}

interface McpAdministrationConfirmationBinding {
  readonly action: Exclude<McpAdministrationAction, { readonly kind: "add" | "remove" | "reset-project-choices" | "authenticate" }>;
  readonly selector: McpAdministrationInteractiveSelector;
  readonly definitionVersion: 1;
  readonly definitionDigest: string;
  readonly profileKey: string;
  readonly checkoutFamilyKey: string;
  readonly policy: McpAdministrationDeclaration["policy"];
  readonly review: McpAdministrationDeclaration["review"];
  readonly status: McpAdministrationDeclaration["status"] | "shadowed";
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

function sameAuthority(left: McpAdministrationDeclaration["authority"], right: McpAdministrationDeclaration["authority"]): boolean {
  return left.kind === right.kind && (left.kind === "mutable"
    ? right.kind === "mutable" && left.scope === right.scope
    : right.kind === "read-only" && left.sourceClass === right.sourceClass);
}

function selectorMatches(server: McpAdministrationInventory["servers"][number], selector: McpAdministrationInteractiveSelector): boolean {
  return server.name === selector.name && server.source === selector.source && server.precedence === selector.precedence &&
    sameAuthority(server.authority, selector.authority) && sameOwner(server.agentOwner, selector.agentOwner);
}

function winners(inventory: McpAdministrationInventory, name: string, owner?: McpAgentOwner): readonly McpAdministrationInventory["servers"][number][] {
  return inventory.servers.filter((server) => server.name === name && server.precedence === "winner" && sameOwner(server.agentOwner, owner));
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

function privateDeclarations(state: McpAdministrationFreshState, name: string, owner?: McpAgentOwner): readonly McpAdministrationDeclaration[] {
  return state.mcp.administration?.declarations.filter((item) => item.name === name && item.precedence === "winner" && sameOwner(item.agentOwner, owner)) ?? [];
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

function confirmedBindingMatches(
  state: McpAdministrationFreshState,
  inventory: McpAdministrationInventory,
  binding: McpAdministrationConfirmationBinding,
  phase: "before" | "after",
): boolean {
  if (state.reviewIdentity.profileKey !== binding.profileKey || state.reviewIdentity.checkoutFamilyKey !== binding.checkoutFamilyKey) return false;
  const selectedWinners = winners(inventory, binding.selector.name, binding.selector.agentOwner);
  if (selectedWinners.length !== 1 || !selectorMatches(selectedWinners[0]!, binding.selector)) return false;
  const declarations = privateDeclarations(state, binding.selector.name, binding.selector.agentOwner);
  if (declarations.length !== 1) return false;
  const declaration = declarations[0]!;
  if (!validPrivateDefinition(declaration) || declaration.source !== binding.selector.source ||
    !sameAuthority(declaration.authority, binding.selector.authority) || !sameOwner(declaration.agentOwner, binding.selector.agentOwner) ||
    declaration.definitionVersion !== binding.definitionVersion || declaration.definitionDigest !== binding.definitionDigest || declaration.policy !== binding.policy) return false;
  if (phase === "before") return declaration.review === binding.review && declaration.status === binding.status;
  if (binding.action.kind === "approve") return declaration.review === "approved-exact" && declaration.status === "enabled";
  if (binding.action.kind === "reject") return declaration.review === "rejected-exact" && declaration.status === "disabled";
  if (binding.action.kind === "disable") return declaration.review === binding.review && declaration.status === "disabled";
  if (binding.action.kind === "enable") return declaration.review === binding.review && declaration.status === "enabled";
  return declaration.review === binding.review && declaration.status === binding.status;
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
  if (action.kind !== "add" && (beforeState.reviewIdentity.profileKey !== afterState.reviewIdentity.profileKey ||
    beforeState.reviewIdentity.checkoutFamilyKey !== afterState.reviewIdentity.checkoutFamilyKey)) return denied("stale-state");
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

interface EffectiveWinner {
  readonly declaration: McpAdministrationDeclaration & { readonly definitionVersion: 1; readonly definitionDigest: string };
  readonly server: EnabledStdioMcpServer | EnabledRemoteMcpServer;
}

function effectiveWinners(state: McpAdministrationFreshState): ReadonlyMap<string, EffectiveWinner> {
  const result = new Map<string, EffectiveWinner>();
  const declarations = state.mcp.administration?.declarations ?? [];
  for (const declaration of declarations) {
    if (declaration.agentOwner !== undefined || declaration.precedence !== "winner" || declaration.policy !== "allowed" ||
      declaration.status !== "enabled" || declaration.review === "pending" || declaration.review === "rejected-exact" ||
      declaration.review === "rejected-compatibility" || !validPrivateDefinition(declaration)) continue;
    const declarationMatches = declarations.filter((candidate) => candidate.name === declaration.name && candidate.agentOwner === undefined && candidate.precedence === "winner");
    const serverMatches = state.mcp.servers.filter((server): server is EnabledStdioMcpServer | EnabledRemoteMcpServer =>
      server.name === declaration.name && server.source === declaration.source && server.status === "enabled");
    if (declarationMatches.length === 1 && serverMatches.length === 1) result.set(declaration.name, { declaration, server: serverMatches[0]! });
  }
  return result;
}

function runtimeAdmission(state: McpAdministrationFreshState, winner: EffectiveWinner): McpAdministrationRuntimeAdmission {
  const declaration = winner.declaration;
  const binding = Object.freeze({
    admittedName: declaration.name,
    admittedSource: declaration.source,
    admittedDefinitionVersion: declaration.definitionVersion,
    admittedDefinitionDigest: declaration.definitionDigest,
    admittedPolicy: "allowed" as const,
    admittedStatus: "enabled" as const,
    admittedProfileKey: state.reviewIdentity.profileKey,
    admittedCheckoutFamilyKey: state.reviewIdentity.checkoutFamilyKey,
  });
  const envelope = Object.freeze(Object.defineProperty({}, MCP_RUNTIME_ADMISSION_BRAND, { value: true })) as McpAdministrationRuntimeAdmission;
  runtimeAdmissions.set(envelope, Object.freeze({ server: winner.server, binding }));
  return envelope;
}

function mintTransition(contents: McpAdministrationRuntimeTransitionContents): McpAdministrationRuntimeTransition {
  const transition = Object.freeze(Object.defineProperty({}, MCP_RUNTIME_TRANSITION_BRAND, { value: true })) as McpAdministrationRuntimeTransition;
  runtimeTransitions.set(transition, Object.freeze(contents));
  return transition;
}

function resetTransitionNames(
  beforeState: McpAdministrationFreshState,
  afterState: McpAdministrationFreshState,
): ReadonlySet<string> {
  const afterDeclarations = afterState.mcp.administration?.declarations ?? [];
  const names = new Set<string>();
  for (const before of beforeState.mcp.administration?.declarations ?? []) {
    if (before.agentOwner !== undefined || before.precedence !== "winner" ||
      (before.review !== "approved-exact" && before.review !== "rejected-exact") ||
      !PROJECT_REVIEW_SOURCES.has(before.source as never) || !validPrivateDefinition(before)) continue;
    const after = afterDeclarations.find((candidate) => candidate.name === before.name && candidate.agentOwner === undefined &&
      candidate.precedence === "winner" && candidate.source === before.source && candidate.definitionVersion === before.definitionVersion &&
      candidate.definitionDigest === before.definitionDigest);
    if (after !== undefined && after.review !== before.review) names.add(before.name);
  }
  return names;
}

function runtimeTransitionsFor(
  action: McpAdministrationAction,
  beforeState: McpAdministrationFreshState,
  afterState: McpAdministrationFreshState,
  addBinding?: McpDeclarationDefinitionBinding,
): readonly McpAdministrationRuntimeTransition[] {
  if (action.kind === "authenticate" || ("agentOwner" in action && action.agentOwner !== undefined)) return Object.freeze([]);
  const before = effectiveWinners(beforeState);
  const after = effectiveWinners(afterState);
  if (action.kind === "reconnect") {
    const current = after.get(action.name);
    return current === undefined ? Object.freeze([]) : Object.freeze([mintTransition({ kind: "reconnect", admission: runtimeAdmission(afterState, current) })]);
  }
  const names = action.kind === "reset-project-choices"
    ? resetTransitionNames(beforeState, afterState)
    : new Set([action.name]);
  if (action.kind === "add") {
    const current = after.get(action.name);
    if (current === undefined || addBinding === undefined || current.declaration.source !== SOURCE_FOR_SCOPE[action.scope] ||
      current.declaration.authority.kind !== "mutable" || current.declaration.authority.scope !== action.scope ||
      current.declaration.definitionVersion !== addBinding.definitionVersion || current.declaration.definitionDigest !== addBinding.definitionDigest) {
      return Object.freeze([]);
    }
  }
  const transitions: McpAdministrationRuntimeTransition[] = [];
  for (const name of [...names].sort()) {
    const oldWinner = before.get(name);
    const newWinner = after.get(name);
    const unchanged = oldWinner !== undefined && newWinner !== undefined &&
      oldWinner.declaration.source === newWinner.declaration.source &&
      oldWinner.declaration.definitionVersion === newWinner.declaration.definitionVersion &&
      oldWinner.declaration.definitionDigest === newWinner.declaration.definitionDigest;
    if (unchanged) continue;
    if (oldWinner !== undefined && newWinner !== undefined) transitions.push(mintTransition({
      kind: "replace", serverName: name, admission: runtimeAdmission(afterState, newWinner),
    }));
    else if (oldWinner !== undefined) transitions.push(mintTransition({ kind: "retire", serverName: name }));
    else if (newWinner !== undefined) transitions.push(mintTransition({ kind: "activate", admission: runtimeAdmission(afterState, newWinner) }));
  }
  return Object.freeze(transitions);
}

function liveRequest(action: McpAdministrationAction, beforeState: McpAdministrationFreshState, afterState: McpAdministrationFreshState, addBinding?: McpDeclarationDefinitionBinding): McpAdministrationLiveRequest {
  const transitions = runtimeTransitionsFor(action, beforeState, afterState, addBinding);
  const admission = transitions.map((transition) => runtimeTransitions.get(transition)).find((contents) => contents?.kind === "activate" || contents?.kind === "replace" || contents?.kind === "reconnect")?.admission;
  return Object.freeze({ action: liveAction(action), transitions, ...(admission === undefined ? {} : { runtimeAdmission: admission }) });
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

  const confirmationBindings = new WeakMap<object, McpAdministrationConfirmationBinding>();
  const consumedConfirmationAuthorities = new WeakSet<object>();

  const interactiveAction = (selector: McpAdministrationInteractiveSelector, kind: McpAdministrationInteractiveAction): McpAdministrationAction =>
    Object.freeze({ kind, name: selector.name, ...(selector.agentOwner === undefined ? {} : { agentOwner: Object.freeze({ ...selector.agentOwner }) }) });

  const interactivePrepare = async (selector: McpAdministrationInteractiveSelector, kind: McpAdministrationInteractiveAction): Promise<McpAdministrationInteractivePreparation> => {
    const pending = await dependencies.inspectPending();
    if (pending.pending) return Object.freeze({ inventory: RECOVERY_BLOCKED_INVENTORY, eligibility: denied("recovery-pending") });
    const state = await dependencies.assemble(); const current = inventoryOf(state);
    const selectedMatches = current.servers.filter((server) => selectorMatches(server, selector));
    const selectedWinners = winners(current, selector.name, selector.agentOwner);
    const selected = selectedMatches.length === 1 && selectedWinners.length === 1 && selectedMatches[0] === selectedWinners[0] ? selectedMatches[0] : undefined;
    if (selected === undefined) {
      const reason = current.servers.some((server) => server.name === selector.name) ? "stale-state" : "server-not-found";
      return Object.freeze({ inventory: current, eligibility: denied(reason) });
    }
    const action = interactiveAction(selector, kind); const eligibility = actionEligibility(state, current, action);
    if (!eligibility.eligible || kind === "authenticate") return Object.freeze({ inventory: current, eligibility });
    const declarations = privateDeclarations(state, selector.name, selector.agentOwner);
    const declaration = declarations.length === 1 && declarations[0]?.source === selector.source && sameAuthority(declarations[0].authority, selector.authority) ? declarations[0] : undefined;
    if (!validPrivateDefinition(declaration)) return Object.freeze({ inventory: current, eligibility: denied(declarations.length === 1 ? "definition-unavailable" : "stale-state") });
    const authority = Object.freeze(Object.defineProperty({}, MCP_CONFIRMATION_AUTHORITY_BRAND, { value: true })) as McpAdministrationConfirmationAuthority;
    confirmationBindings.set(authority, Object.freeze({
      action: action as Exclude<McpAdministrationAction, { readonly kind: "add" | "remove" | "reset-project-choices" | "authenticate" }>,
      selector: Object.freeze({ ...selector, authority: Object.freeze({ ...selector.authority }), ...(selector.agentOwner === undefined ? {} : { agentOwner: Object.freeze({ ...selector.agentOwner }) }) }),
      definitionVersion: declaration.definitionVersion, definitionDigest: declaration.definitionDigest,
      profileKey: state.reviewIdentity.profileKey, checkoutFamilyKey: state.reviewIdentity.checkoutFamilyKey,
      policy: declaration.policy, review: declaration.review, status: declaration.status,
    }));
    return Object.freeze({ inventory: current, eligibility, authority });
  };

  const runFromFresh = async (action: McpAdministrationAction, beforeState: McpAdministrationFreshState, before: McpAdministrationInventory, recovery: McpAdministrationResult["recovery"], initialEligibility: McpAdministrationEligibility, addBinding?: McpDeclarationDefinitionBinding, confirmationBinding?: McpAdministrationConfirmationBinding): Promise<McpAdministrationResult> => {
    if (!initialEligibility.eligible) return Object.freeze({ inventory: before, eligibility: initialEligibility, recovery, durable: NOT_REQUESTED, runtime: NOT_REQUESTED, exposure: NOT_REQUESTED });
    const mutation = persistenceMutation(beforeState, action, addBinding); let durable: McpAdministrationResult["durable"] = NOT_REQUESTED;
    if (mutation !== undefined) {
      durable = await dependencies.mutate(mutation);
      const afterState = await dependencies.assemble(); const after = inventoryOf(afterState);
      if (durable.state !== "committed") {
        const reason = durable.state === "pending-recovery" ? "recovery-pending" : durable.cleanup === "pending" ? "cleanup-pending" : "durable-mutation-failed";
        return Object.freeze({ inventory: after, eligibility: denied(reason), recovery, durable, runtime: NOT_REQUESTED, exposure: NOT_REQUESTED });
      }
      if (durable.cleanup === "pending") return Object.freeze({ inventory: after, eligibility: denied("cleanup-pending"), recovery, durable, runtime: NOT_REQUESTED, exposure: NOT_REQUESTED });
      if (confirmationBinding !== undefined && !confirmedBindingMatches(afterState, after, confirmationBinding, "after")) {
        return Object.freeze({ inventory: after, eligibility: denied("stale-state"), recovery, durable, runtime: NOT_REQUESTED, exposure: NOT_REQUESTED });
      }
      const finalEligibility = postcommitEligibility(action, beforeState, afterState, before, after, addBinding, durable);
      if (!finalEligibility.eligible) return Object.freeze({ inventory: after, eligibility: finalEligibility, recovery, durable, runtime: NOT_REQUESTED, exposure: NOT_REQUESTED });
      if (durable.effect === "unchanged" || dependencies.live === undefined || action.kind === "authenticate") return Object.freeze({ inventory: after, eligibility: finalEligibility, recovery, durable, runtime: NOT_REQUESTED, exposure: NOT_REQUESTED });
      const request = liveRequest(action, beforeState, afterState, addBinding);
      if (request.transitions.length === 0) return Object.freeze({ inventory: after, eligibility: finalEligibility, recovery, durable, runtime: NOT_REQUESTED, exposure: NOT_REQUESTED });
      try { const live = await dependencies.live.apply(request); return Object.freeze({ inventory: after, eligibility: finalEligibility, recovery, durable, runtime: live.runtime, exposure: live.exposure }); }
      catch { return Object.freeze({ inventory: after, eligibility: finalEligibility, recovery, durable, runtime: Object.freeze({ state: "failed" as const, reasonCode: "live-port-failure" }), exposure: NOT_REQUESTED }); }
    }
    const afterState = await dependencies.assemble(); const after = inventoryOf(afterState);
    if (confirmationBinding !== undefined && !confirmedBindingMatches(afterState, after, confirmationBinding, "after")) {
      return Object.freeze({ inventory: after, eligibility: denied("stale-state"), recovery, durable, runtime: NOT_REQUESTED, exposure: NOT_REQUESTED });
    }
    const finalEligibility = postcommitEligibility(action, beforeState, afterState, before, after, addBinding);
    if (!finalEligibility.eligible || dependencies.live === undefined || action.kind === "authenticate") return Object.freeze({ inventory: after, eligibility: finalEligibility, recovery, durable, runtime: NOT_REQUESTED, exposure: NOT_REQUESTED });
    const request = liveRequest(action, beforeState, afterState, addBinding);
    if (request.transitions.length === 0) return Object.freeze({ inventory: after, eligibility: finalEligibility, recovery, durable, runtime: NOT_REQUESTED, exposure: NOT_REQUESTED });
    try { const live = await dependencies.live.apply(request); return Object.freeze({ inventory: after, eligibility: finalEligibility, recovery, durable, runtime: live.runtime, exposure: live.exposure }); }
    catch { return Object.freeze({ inventory: after, eligibility: finalEligibility, recovery, durable, runtime: Object.freeze({ state: "failed" as const, reasonCode: "live-port-failure" }), exposure: NOT_REQUESTED }); }
  };

  const execute = async (action: McpAdministrationAction): Promise<McpAdministrationResult> => {
    const pending = await dependencies.inspectPending(); let recovery: McpAdministrationResult["recovery"] = NOT_REQUESTED;
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
    return runFromFresh(action, beforeState, before, recovery, actionEligibility(beforeState, before, action, addBinding), addBinding);
  };

  const confirmedExecute = async (authority: McpAdministrationConfirmationAuthority): Promise<McpAdministrationResult> => {
    const candidate = typeof authority === "object" && authority !== null ? authority : undefined;
    const binding = candidate === undefined || consumedConfirmationAuthorities.has(candidate) ? undefined : confirmationBindings.get(candidate);
    if (candidate !== undefined) { confirmationBindings.delete(candidate); consumedConfirmationAuthorities.add(candidate); }
    const pendingBeforeFresh = await dependencies.inspectPending();
    if (binding === undefined) {
      const current = pendingBeforeFresh.pending ? RECOVERY_BLOCKED_INVENTORY : inventoryOf(await dependencies.assemble());
      return Object.freeze({ inventory: current, eligibility: denied("stale-state"), recovery: NOT_REQUESTED, durable: NOT_REQUESTED, runtime: NOT_REQUESTED, exposure: NOT_REQUESTED });
    }
    if (pendingBeforeFresh.pending) return Object.freeze({ inventory: RECOVERY_BLOCKED_INVENTORY, eligibility: denied("recovery-pending"), recovery: NOT_REQUESTED, durable: NOT_REQUESTED, runtime: NOT_REQUESTED, exposure: NOT_REQUESTED });
    const beforeState = await dependencies.assemble(); const before = inventoryOf(beforeState);
    if (!confirmedBindingMatches(beforeState, before, binding, "before")) return Object.freeze({ inventory: before, eligibility: denied("stale-state"), recovery: NOT_REQUESTED, durable: NOT_REQUESTED, runtime: NOT_REQUESTED, exposure: NOT_REQUESTED });
    const eligibility = actionEligibility(beforeState, before, binding.action);
    if (!eligibility.eligible) return Object.freeze({ inventory: before, eligibility: denied("stale-state"), recovery: NOT_REQUESTED, durable: NOT_REQUESTED, runtime: NOT_REQUESTED, exposure: NOT_REQUESTED });
    if ((await dependencies.inspectPending()).pending) return Object.freeze({ inventory: RECOVERY_BLOCKED_INVENTORY, eligibility: denied("recovery-pending"), recovery: NOT_REQUESTED, durable: NOT_REQUESTED, runtime: NOT_REQUESTED, exposure: NOT_REQUESTED });
    return runFromFresh(binding.action, beforeState, before, NOT_REQUESTED, eligibility, undefined, binding);
  };

  return Object.freeze({ inventory, prepareInventoryAfterRecovery, preview, execute, interactivePrepare, confirmedExecute });
}

export type McpAdministrationService = ReturnType<typeof createMcpAdministrationService>;

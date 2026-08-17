import { matchesRule, parseRule, type PermissionEngine } from "../engine/permissions.js";
import type {
  AgentMcpDeclaration,
  ClaudeAgent,
  DeepReadonly,
  HookConfig,
  SourceRef,
  ToolCallDescriptor,
} from "../types.js";
import { neutralizeControlChars } from "../util/neutralize-text.js";
import { toClaudeToolName } from "./tool-map.js";
import type { SelectedMainAgentResolution } from "./selected-main-agent-selection.js";

export const SELECTED_MAIN_AGENT_SAFE_RECOVERY_PROMPT =
  "PiCC could not safely restore the selected main-session agent. Continue only to help the user select an available agent and start a fresh session; do not use tools or claim the previous identity.";
export const SELECTED_MAIN_AGENT_ADMISSION_RECOVERY =
  "Correct the selected agent definition or selector, then start a fresh PiCC session.";

export type SelectedMainAgentDiagnosticReason =
  | "selected-agent-active"
  | "selected-agent-missing-fresh"
  | "selected-agent-missing-persisted"
  | "selected-agent-persistence-uncertain"
  | "selected-agent-tool-restrictions-invalid"
  | "selected-agent-tool-restrictions-uncertain";

export type SelectedMainAgentUnsupportedReason =
  | "max-turns-unsupported-for-main"
  | "background-unsupported-for-main"
  | "isolation-unsupported-for-main"
  | "color-unsupported-for-main";

export interface SelectedMainAgentDiagnostic {
  readonly reason: SelectedMainAgentDiagnosticReason;
  readonly agentIdentity: string;
}

interface SelectedDefinitionSnapshot {
  readonly requestedName: string;
  readonly resolvedName: string;
  readonly selectorSource: "cli" | "persisted" | "settings";
  readonly appendSelectionEntry: boolean;
  readonly body: string;
  readonly tools?: readonly string[];
  readonly disallowedTools?: readonly string[];
  readonly model?: string;
  readonly effort?: string;
  readonly permissionMode?: string;
  readonly skills?: readonly string[];
  readonly memory?: unknown;
  readonly hooks?: DeepReadonly<HookConfig>;
  readonly agentMcp?: DeepReadonly<AgentMcpDeclaration>;
  readonly initialPrompt?: string;
  readonly metadata: DeepReadonly<Record<string, unknown>>;
  readonly source: DeepReadonly<SourceRef>;
  readonly unsupported: readonly SelectedMainAgentUnsupportedReason[];
}

export interface SelectedMainAgentSelectedSnapshot extends SelectedDefinitionSnapshot {
  readonly kind: "selected";
  readonly diagnostic: SelectedMainAgentDiagnostic;
}

export interface SelectedMainAgentSafeFallbackSnapshot {
  readonly kind: "safe-fallback";
  readonly requestedName?: string;
  readonly recoveryPrompt: string;
  readonly tools: readonly [];
  readonly subagentTypes: readonly [];
  readonly diagnostic: SelectedMainAgentDiagnostic;
}

export interface SelectedMainAgentAdmissionDeniedSnapshot {
  readonly kind: "admission-denied";
  readonly requestedName?: string;
  readonly recoveryText: string;
  readonly providerInputBlocked: true;
  readonly tools: readonly [];
  readonly subagentTypes: readonly [];
  readonly diagnostic: SelectedMainAgentDiagnostic;
}

export type SelectedMainAgentRuntimeSnapshot =
  | SelectedMainAgentSelectedSnapshot
  | SelectedMainAgentSafeFallbackSnapshot
  | SelectedMainAgentAdmissionDeniedSnapshot;

const EMPTY = Object.freeze([]) as readonly [];
const DIAGNOSTIC_IDENTITY_MAX_CHARS = 128;

function diagnosticIdentity(value: unknown): string {
  if (typeof value !== "string") return "unavailable";
  const sanitized = neutralizeControlChars(value).replace(/\s+/gu, " ").trim();
  if (sanitized === "") return "unavailable";
  const codePoints = Array.from(sanitized);
  return codePoints.length <= DIAGNOSTIC_IDENTITY_MAX_CHARS
    ? sanitized
    : `${codePoints.slice(0, DIAGNOSTIC_IDENTITY_MAX_CHARS - 1).join("")}…`;
}

function fixedDiagnostic(
  reason: SelectedMainAgentDiagnosticReason,
  identity: unknown,
): SelectedMainAgentDiagnostic {
  return Object.freeze({ reason, agentIdentity: diagnosticIdentity(identity) });
}

function cloneFrozen<T>(value: T, seen = new WeakMap<object, unknown>()): T {
  if (value === null || typeof value !== "object") return value;
  const prior = seen.get(value);
  if (prior !== undefined) return prior as T;
  if (Array.isArray(value)) {
    const copy: unknown[] = [];
    seen.set(value, copy);
    for (const item of value) copy.push(cloneFrozen(item, seen));
    return Object.freeze(copy) as T;
  }
  const copy: Record<string, unknown> = {};
  seen.set(value, copy);
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if (!descriptor.enumerable || !("value" in descriptor)) continue;
    copy[key] = cloneFrozen(descriptor.value, seen);
  }
  return Object.freeze(copy) as T;
}

function copiedStrings(value: string[] | undefined): readonly string[] | undefined {
  return value === undefined ? undefined : Object.freeze([...value]);
}

function restrictionProvenance(agent: ClaudeAgent): "valid" | "invalid" | "uncertain" {
  const validation = agent.toolRestrictionValidation;
  if (validation === undefined) return agent.builtin ? "valid" : "uncertain";
  if (validation.tools === "invalid" || validation.disallowedTools === "invalid") return "invalid";
  const toolsConsistent = validation.tools === "absent"
    ? agent.tools === undefined
    : Array.isArray(agent.tools) && agent.tools.every((entry) => typeof entry === "string");
  const disallowedConsistent = validation.disallowedTools === "absent"
    ? agent.disallowedTools === undefined
    : Array.isArray(agent.disallowedTools)
      && agent.disallowedTools.every((entry) => typeof entry === "string");
  return toolsConsistent && disallowedConsistent ? "valid" : "uncertain";
}

function unsupportedReasons(agent: ClaudeAgent): readonly SelectedMainAgentUnsupportedReason[] {
  const reasons: SelectedMainAgentUnsupportedReason[] = [];
  if (agent.maxTurns !== undefined) reasons.push("max-turns-unsupported-for-main");
  if (agent.background !== undefined) reasons.push("background-unsupported-for-main");
  if (agent.isolation !== undefined) reasons.push("isolation-unsupported-for-main");
  if (agent.color !== undefined) reasons.push("color-unsupported-for-main");
  return Object.freeze(reasons);
}

function denied(
  resolution: Extract<SelectedMainAgentResolution, { kind: "missing-fresh" }> | Extract<SelectedMainAgentResolution, { kind: "selected" }>,
  reason: SelectedMainAgentDiagnosticReason,
): SelectedMainAgentAdmissionDeniedSnapshot {
  const requestedName = resolution.kind === "selected" ? resolution.requestedName : resolution.requestedName;
  return Object.freeze({
    kind: "admission-denied",
    ...(requestedName === undefined ? {} : { requestedName }),
    recoveryText: SELECTED_MAIN_AGENT_ADMISSION_RECOVERY,
    providerInputBlocked: true,
    tools: EMPTY,
    subagentTypes: EMPTY,
    diagnostic: fixedDiagnostic(reason, requestedName),
  });
}

/** Freeze selection output into a session-owned policy value. No selection remains ordinary PiCC. */
export function createSelectedMainAgentRuntimeSnapshot(
  resolution: SelectedMainAgentResolution,
): SelectedMainAgentRuntimeSnapshot | undefined {
  if (resolution.kind === "none") return undefined;
  if (resolution.kind === "missing-fresh") {
    return denied(resolution, "selected-agent-missing-fresh");
  }
  if (resolution.kind === "missing-persisted" || resolution.kind === "persisted-uncertain") {
    const requestedName = resolution.kind === "missing-persisted" ? resolution.requestedName : undefined;
    return Object.freeze({
      kind: "safe-fallback",
      ...(requestedName === undefined ? {} : { requestedName }),
      recoveryPrompt: SELECTED_MAIN_AGENT_SAFE_RECOVERY_PROMPT,
      tools: EMPTY,
      subagentTypes: EMPTY,
      diagnostic: fixedDiagnostic(
        resolution.kind === "missing-persisted"
          ? "selected-agent-missing-persisted"
          : "selected-agent-persistence-uncertain",
        requestedName,
      ),
    });
  }

  const provenance = restrictionProvenance(resolution.agent);
  if (provenance !== "valid") {
    return denied(
      resolution,
      provenance === "invalid"
        ? "selected-agent-tool-restrictions-invalid"
        : "selected-agent-tool-restrictions-uncertain",
    );
  }
  const agent = resolution.agent;
  return Object.freeze({
    kind: "selected",
    requestedName: resolution.requestedName,
    resolvedName: agent.name,
    selectorSource: resolution.source,
    appendSelectionEntry: resolution.appendSelectionEntry,
    body: agent.body,
    ...(agent.tools === undefined ? {} : { tools: copiedStrings(agent.tools) }),
    ...(agent.disallowedTools === undefined ? {} : { disallowedTools: copiedStrings(agent.disallowedTools) }),
    ...(agent.model === undefined ? {} : { model: agent.model }),
    ...(agent.effort === undefined ? {} : { effort: agent.effort }),
    ...(agent.permissionMode === undefined ? {} : { permissionMode: agent.permissionMode }),
    ...(agent.skills === undefined ? {} : { skills: copiedStrings(agent.skills) }),
    ...(agent.memory === undefined ? {} : { memory: cloneFrozen(agent.memory) }),
    ...(agent.hooks === undefined ? {} : { hooks: cloneFrozen(agent.hooks) }),
    ...(agent.agentMcp === undefined ? {} : { agentMcp: cloneFrozen(agent.agentMcp) }),
    ...(agent.initialPrompt === undefined ? {} : { initialPrompt: agent.initialPrompt }),
    metadata: cloneFrozen(agent.metadata),
    source: cloneFrozen(agent.source),
    unsupported: unsupportedReasons(agent),
    diagnostic: fixedDiagnostic("selected-agent-active", agent.name),
  });
}

export type SelectedMainAgentToolDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: "selected-session-tool-denied" };

const ALLOWED = Object.freeze({ allowed: true }) as SelectedMainAgentToolDecision;
const DENIED = Object.freeze({
  allowed: false,
  reason: "selected-session-tool-denied",
}) as SelectedMainAgentToolDecision;

function normalizedAgentCall(call: ToolCallDescriptor): ToolCallDescriptor | undefined {
  if (call.tool !== "Agent" && call.tool !== "Task") return call;
  const value = call.input?.["subagent_type"];
  if (value !== undefined && typeof value !== "string") return undefined;
  return {
    ...call,
    input: { ...(call.input ?? {}), subagent_type: value ?? "general-purpose" },
  };
}

function selectedAgentTaskAliases(rules: readonly string[] | undefined): string[] | undefined {
  if (rules === undefined) return undefined;
  const expanded: string[] = [];
  for (const ruleText of rules) {
    expanded.push(ruleText);
    const rule = parseRule(ruleText);
    if (rule.tool !== "Agent" && rule.tool !== "Task") continue;
    const alias = rule.tool === "Agent" ? "Task" : "Agent";
    expanded.push(rule.specifier === undefined ? alias : `${alias}(${rule.specifier})`);
  }
  return expanded;
}

function selectedRuleMatches(
  ruleText: string,
  call: ToolCallDescriptor,
  opts: {
    readonly anchor: string;
    readonly deny?: true;
    readonly anySegment?: true;
    readonly catalogCandidate?: true;
  },
): boolean {
  if (call.tool !== "Agent" && call.tool !== "Task") return matchesRule(ruleText, call, opts);
  const rule = parseRule(ruleText);
  if (rule.tool !== "Agent" && rule.tool !== "Task") return matchesRule(ruleText, call, opts);
  const aliasedCall = { ...call, tool: rule.tool };
  if (rule.specifier === undefined || rule.specifier === "") return true;

  const parameter = /^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*[\s\S]*$/u.exec(rule.specifier);
  if (parameter?.[1] !== undefined && parameter[1] !== "subagent_type") {
    if (opts.catalogCandidate && !opts.deny) return true;
    return matchesRule(ruleText, aliasedCall, opts);
  }
  const typePatterns = rule.specifier.split(/[\s,]+/u).filter(Boolean);
  return typePatterns.some((pattern) => matchesRule(`${rule.tool}(${pattern})`, aliasedCall, opts));
}

/** One immutable owner for selected-session exposure, catalog, and call-time decisions. */
export class SelectedMainAgentToolPolicy {
  readonly executableSubagentTypes: readonly string[];
  private readonly executableTypeSet: ReadonlySet<string>;

  constructor(
    readonly snapshot: SelectedMainAgentRuntimeSnapshot,
    private readonly engine: PermissionEngine,
    availableSubagentTypes: readonly string[] = [],
  ) {
    const admitted = snapshot.kind === "selected"
      ? availableSubagentTypes.filter((type) => this.evaluateRestrictions({
          tool: "Agent",
          input: { subagent_type: type },
          cwd: this.anchor(),
        }, true).allowed)
      : [];
    this.executableSubagentTypes = Object.freeze([...new Set(admitted)]);
    this.executableTypeSet = new Set(this.executableSubagentTypes);
    Object.freeze(this);
  }

  activeToolNames(knownRegistryNames: readonly string[]): readonly string[] {
    if (this.snapshot.kind !== "selected") return EMPTY;
    const canonical = knownRegistryNames.map(toClaudeToolName);
    const granted = new Set(this.engine.gateTools(
      selectedAgentTaskAliases(this.snapshot.tools),
      selectedAgentTaskAliases(this.snapshot.disallowedTools),
      canonical,
    ));
    return Object.freeze(knownRegistryNames.filter((name, index) => granted.has(canonical[index]!)));
  }

  catalogSubagentTypes(): readonly string[] {
    return this.executableSubagentTypes;
  }

  evaluateCall(call: ToolCallDescriptor): SelectedMainAgentToolDecision {
    if (this.snapshot.kind !== "selected") return DENIED;
    const normalized = normalizedAgentCall(call);
    if (normalized === undefined) return DENIED;
    const restricted = this.evaluateRestrictions(normalized);
    if (!restricted.allowed) return restricted;
    if (normalized.tool === "Agent" || normalized.tool === "Task") {
      const type = normalized.input?.["subagent_type"];
      if (typeof type !== "string" || !this.executableTypeSet.has(type)) return DENIED;
    }
    return ALLOWED;
  }

  private evaluateRestrictions(
    call: ToolCallDescriptor,
    catalogCandidate = false,
  ): SelectedMainAgentToolDecision {
    if (this.snapshot.kind !== "selected") return DENIED;
    try {
      if (this.engine.evaluate(call).decision === "deny") return DENIED;
      const anchor = this.anchor();
      if (this.snapshot.tools !== undefined
        && !this.snapshot.tools.some((rule) => selectedRuleMatches(
          rule,
          call,
          catalogCandidate ? { anchor, catalogCandidate: true } : { anchor },
        ))) return DENIED;
      if (this.snapshot.disallowedTools?.some((rule) =>
        selectedRuleMatches(rule, call, { anchor, deny: true, anySegment: true }))) return DENIED;
      return ALLOWED;
    } catch {
      return DENIED;
    }
  }

  private anchor(): string {
    try {
      return this.engine.pathAnchor;
    } catch {
      return process.cwd();
    }
  }
}

export interface ActiveToolHost {
  getActiveTools(): string[];
  setActiveTools(names: string[]): void;
}

export type SelectedMainAgentActiveToolReconciliation =
  | { readonly ok: true; readonly activeTools: readonly string[] }
  | {
      readonly ok: false;
      readonly failure: "get-active-tools" | "policy-evaluation" | "set-active-tools";
      readonly lastApplied: readonly string[];
    };

/** Tracks only Pi-observable active intent while intersecting it with the installed policy. */
export class SelectedMainAgentActiveToolReconciler {
  private ceiling = new Set<string>();
  private lastApplied = new Set<string>();
  private policy: SelectedMainAgentToolPolicy | undefined;
  private initialGetFailed = false;
  private pending?: {
    readonly desired: readonly string[];
    readonly candidateCeiling: ReadonlySet<string>;
  };

  constructor(private readonly host: ActiveToolHost, policy?: SelectedMainAgentToolPolicy) {
    this.policy = policy;
    try {
      for (const name of host.getActiveTools()) {
        if (typeof name === "string") this.ceiling.add(name);
      }
      this.lastApplied = new Set(this.ceiling);
    } catch {
      this.initialGetFailed = true;
    }
  }

  setPolicy(policy: SelectedMainAgentToolPolicy | undefined): void {
    this.policy = policy;
  }

  reconcile(knownRegistryNames: readonly string[]): SelectedMainAgentActiveToolReconciliation {
    if (this.initialGetFailed) {
      this.initialGetFailed = false;
      return this.failure("get-active-tools");
    }

    let current: Set<string>;
    try {
      current = new Set(this.host.getActiveTools().filter((name): name is string => typeof name === "string"));
    } catch {
      return this.failure("get-active-tools");
    }

    if (this.pending !== undefined) {
      const pending = this.pending;
      if (!this.sameNames(current, pending.desired)) {
        try {
          this.host.setActiveTools([...pending.desired]);
        } catch {
          return this.failure("set-active-tools");
        }
      }
      this.ceiling = new Set(pending.candidateCeiling);
      this.lastApplied = new Set(pending.desired);
      this.pending = undefined;
      current = new Set(pending.desired);
    }

    const candidateCeiling = new Set(this.ceiling);
    for (const name of current) candidateCeiling.add(name);
    for (const name of this.lastApplied) {
      if (!current.has(name)) candidateCeiling.delete(name);
    }
    const eligible = knownRegistryNames.filter((name) => candidateCeiling.has(name));
    let desired: string[];
    try {
      desired = this.policy === undefined
        ? eligible
        : [...this.policy.activeToolNames(eligible)];
    } catch {
      return this.failure("policy-evaluation");
    }
    if (this.sameNames(current, desired)) {
      this.ceiling = candidateCeiling;
      this.lastApplied = new Set(desired);
      return Object.freeze({ ok: true, activeTools: Object.freeze([...desired]) });
    }
    this.pending = {
      desired: Object.freeze([...desired]),
      candidateCeiling,
    };
    try {
      this.host.setActiveTools(desired);
    } catch {
      return this.failure("set-active-tools");
    }
    this.ceiling = candidateCeiling;
    this.lastApplied = new Set(desired);
    this.pending = undefined;
    return Object.freeze({ ok: true, activeTools: Object.freeze([...desired]) });
  }

  private sameNames(actual: ReadonlySet<string>, expected: readonly string[]): boolean {
    return actual.size === expected.length && expected.every((name) => actual.has(name));
  }

  private failure(
    failure: Extract<SelectedMainAgentActiveToolReconciliation, { ok: false }>["failure"],
  ): SelectedMainAgentActiveToolReconciliation {
    return Object.freeze({
      ok: false,
      failure,
      lastApplied: Object.freeze([...this.lastApplied]),
    });
  }
}

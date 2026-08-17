import type {
  AgentMcpScope,
  McpInactiveReason,
  McpPolicyInactiveReason,
  McpPolicyPosture,
  McpSourceClass,
  McpServerStatus,
} from "../types.js";

export const MCP_ADMINISTRATION_MODEL_VERSION = 1 as const;

export type McpMutationScope = "local" | "project" | "user";
export type McpAdministrationSource = McpSourceClass | "subagent-inline";

export type McpDeclarationAuthority =
  | { readonly kind: "mutable"; readonly scope: McpMutationScope }
  | { readonly kind: "read-only"; readonly sourceClass: McpAdministrationSource };

export interface McpAgentOwner {
  readonly name: string;
  readonly scope: AgentMcpScope;
}

export interface McpReviewIdentity {
  readonly profileKey: string;
  readonly checkoutFamilyKey: string;
  readonly source: McpAdministrationSource;
  readonly serverName: string;
  readonly agentOwner?: McpAgentOwner;
}

export type McpReviewDecision = "approved" | "rejected";

export interface McpReviewRecord extends McpReviewIdentity {
  readonly definitionVersion: 1;
  readonly definitionDigest: string;
  readonly decision: McpReviewDecision;
}

export interface McpReviewSnapshot {
  readonly version: 1;
  readonly profileKey: string;
  readonly checkoutFamilyKey: string;
  readonly records: readonly McpReviewRecord[];
}

export type McpReviewPosture =
  | "not-required"
  | "pending"
  | "approved-exact"
  | "rejected-exact"
  | "approved-broad-name"
  | "approved-broad-all"
  | "rejected-compatibility";

export interface McpSafeDeclarationSummary {
  readonly transport?: "stdio" | "http" | "sse";
  readonly configuredType?: "http" | "streamable-http" | "sse";
  readonly commandBasename?: string;
  readonly remoteOrigin?: string;
  readonly argumentCount: number;
  readonly environmentKeyCount: number;
  readonly headerKeyCount: number;
  readonly timeoutConfigured: boolean;
}

export interface McpAdministrationDeclaration {
  readonly name: string;
  readonly source: McpAdministrationSource;
  readonly agentOwner?: McpAgentOwner;
  readonly authority: McpDeclarationAuthority;
  readonly precedence: "winner" | "shadowed";
  readonly definitionVersion?: 1;
  readonly definitionDigest?: string;
  readonly summary: McpSafeDeclarationSummary;
  readonly policy: "allowed" | McpPolicyInactiveReason | "invalid";
  readonly review: McpReviewPosture;
  readonly status: McpServerStatus | "shadowed";
  readonly inactiveReason?: McpInactiveReason | McpPolicyInactiveReason | "admission-unavailable";
}

export type McpAdministrationObservation =
  | "ordinary-sources-suppressed-by-managed-mcp"
  | "review-snapshot-unavailable-or-invalid"
  | "administration-recovery-pending"
  | "administration-declarations-omitted";

export type McpAdministrationRemediation = "administration-recovery-pending";

export interface McpAdministrationTrace {
  readonly version: 1;
  readonly policyPosture: McpPolicyPosture;
  readonly observations: readonly McpAdministrationObservation[];
  readonly remediation?: McpAdministrationRemediation;
  readonly declarations: readonly McpAdministrationDeclaration[];
  readonly omittedDeclarationCount: number;
}

export interface McpAdministrationLiveState {
  readonly name: string;
  readonly agentOwner?: McpAgentOwner;
  readonly state: "starting" | "connecting" | "connected" | "reconnecting" | "failed" | "stopped";
  readonly toolCount?: number;
  readonly promptCount?: number;
  readonly resourceCount?: number;
}

export interface McpAdministrationInventoryItem extends Omit<
  McpAdministrationDeclaration,
  "definitionVersion" | "definitionDigest"
> {
  readonly live: McpAdministrationLiveState["state"] | "not-running";
  readonly capabilityCounts: {
    readonly tools: number;
    readonly prompts: number;
    readonly resources: number;
  };
}

export interface McpAdministrationInventory {
  readonly version: 1;
  readonly policyPosture: McpPolicyPosture;
  readonly observations: readonly McpAdministrationObservation[];
  readonly remediation?: McpAdministrationRemediation;
  readonly servers: readonly McpAdministrationInventoryItem[];
  readonly omittedDeclarationCount: number;
}

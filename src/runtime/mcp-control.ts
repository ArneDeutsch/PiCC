import type { McpAdministrationRuntimeAdmission } from "../mcp-administration/service.js";
import type { McpPromptInfo, McpResourceServerInfo, McpToolInfo } from "./mcp.js";

/** Opaque fresh-state authority created by the administration service. */
export type McpRuntimeAdmission = McpAdministrationRuntimeAdmission;

export interface McpCatalogToolDefinition {
  readonly info: McpToolInfo;
  readonly wireDefinitionFingerprint: string;
}

export interface McpCatalogPromptDefinition {
  readonly info: McpPromptInfo;
  readonly wireDefinitionFingerprint: string;
}

export interface McpCatalogResourceDefinition {
  readonly info: McpResourceServerInfo;
  readonly wireDefinitionFingerprint: string;
}

export interface McpCatalogDelta {
  readonly serverName: string;
  readonly definitionFingerprint: string;
  readonly generation: number;
  readonly kind: "publish" | "retire";
  readonly tools: readonly McpCatalogToolDefinition[];
  readonly prompts: readonly McpCatalogPromptDefinition[];
  readonly resourceServer?: McpCatalogResourceDefinition;
}

export type McpRuntimeControlReason =
  | "already-current"
  | "already-inactive"
  | "cleanup-unconfirmed"
  | "connection-failed"
  | "definition-unavailable"
  | "generation-stale"
  | "not-failed"
  | "route-absent"
  | "shutting-down";

export type McpCleanupPosture = "not-required" | "confirmed" | "unconfirmed";

export interface McpRuntimeControlResult {
  readonly state: "succeeded" | "failed";
  readonly reason?: McpRuntimeControlReason;
  readonly cleanup: McpCleanupPosture;
  readonly deltas: readonly McpCatalogDelta[];
}

import { createHash } from "node:crypto";
import path from "node:path";
import type { RawMcpEntry } from "../claude/mcp-config.js";
import type {
  McpAdministrationSource,
  McpAgentOwner,
  McpReviewIdentity,
  McpReviewRecord,
  McpReviewSnapshot,
} from "./model.js";

export const MCP_REVIEW_DEFINITION_VERSION = 1 as const;
export const MCP_REVIEW_LIMITS = Object.freeze({ records: 512, identityChars: 512 });

const REVIEW_SOURCES = new Set<McpAdministrationSource>([
  "native-local", "project-mcpjson", "native-user", "settings-managed", "settings-local",
  "settings-project", "settings-user", "managed-mcp", "subagent-inline",
]);
const AGENT_SCOPES = new Set(["project", "user"] as const);
const DIGEST_PATTERN = /^mcp-review-v1:[a-f0-9]{64}$/u;

function dataRecord(value: unknown): Readonly<Record<PropertyKey, unknown>> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return undefined;
  if (Object.getOwnPropertySymbols(value).length > 0) return undefined;
  const descriptors = Object.getOwnPropertyDescriptors(value) as Record<string, PropertyDescriptor>;
  for (const descriptor of Object.values(descriptors)) {
    if (!("value" in descriptor)) return undefined;
  }
  return Object.fromEntries(Object.entries(descriptors).map(([key, descriptor]) => [key, descriptor.value]));
}

function boundedIdentity(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MCP_REVIEW_LIMITS.identityChars;
}

export interface ValidatedMcpReviewSnapshot {
  readonly snapshot?: McpReviewSnapshot;
  readonly invalid: boolean;
}

/** Copies one untrusted review snapshot without evaluating any property accessor. */
export function validateAndCopyMcpReviewSnapshot(value: unknown): ValidatedMcpReviewSnapshot {
  if (value === undefined) return Object.freeze({ invalid: false });
  try {
    const snapshot = dataRecord(value);
    if (snapshot === undefined || snapshot.version !== 1 || !boundedIdentity(snapshot.profileKey) ||
      !boundedIdentity(snapshot.checkoutFamilyKey) || !Array.isArray(snapshot.records)) {
      return Object.freeze({ invalid: true });
    }
    if (Object.getOwnPropertySymbols(snapshot.records).length > 0) return Object.freeze({ invalid: true });
    const recordDescriptors = Object.getOwnPropertyDescriptors(snapshot.records) as Record<string, PropertyDescriptor>;
    if (Object.values(recordDescriptors).some((descriptor) => !("value" in descriptor))) {
      return Object.freeze({ invalid: true });
    }
    const lengthDescriptor = recordDescriptors["length"];
    if (lengthDescriptor === undefined || !("value" in lengthDescriptor) ||
      typeof lengthDescriptor.value !== "number" || lengthDescriptor.value > MCP_REVIEW_LIMITS.records) {
      return Object.freeze({ invalid: true });
    }
    const records: McpReviewRecord[] = [];
    for (let index = 0; index < lengthDescriptor.value; index++) {
      const itemDescriptor = Object.getOwnPropertyDescriptor(snapshot.records, String(index));
      if (itemDescriptor === undefined || !("value" in itemDescriptor)) return Object.freeze({ invalid: true });
      const item = dataRecord(itemDescriptor.value);
      if (item === undefined || item.definitionVersion !== 1 || typeof item.definitionDigest !== "string" ||
        !DIGEST_PATTERN.test(item.definitionDigest) ||
        !boundedIdentity(item.profileKey) || !boundedIdentity(item.checkoutFamilyKey) ||
        !REVIEW_SOURCES.has(item.source as McpAdministrationSource) || !boundedIdentity(item.serverName) ||
        (item.decision !== "approved" && item.decision !== "rejected")) {
        return Object.freeze({ invalid: true });
      }
      let agentOwner: McpAgentOwner | undefined;
      if (item.agentOwner !== undefined) {
        const owner = dataRecord(item.agentOwner);
        if (owner === undefined || !boundedIdentity(owner.name) || !AGENT_SCOPES.has(owner.scope as never)) {
          return Object.freeze({ invalid: true });
        }
        agentOwner = Object.freeze({ name: owner.name, scope: owner.scope as McpAgentOwner["scope"] });
      }
      records.push(Object.freeze({
        profileKey: item.profileKey,
        checkoutFamilyKey: item.checkoutFamilyKey,
        source: item.source as McpAdministrationSource,
        serverName: item.serverName,
        ...(agentOwner === undefined ? {} : { agentOwner }),
        definitionVersion: 1,
        definitionDigest: item.definitionDigest as string,
        decision: item.decision,
      }));
    }
    return Object.freeze({
      invalid: false,
      snapshot: Object.freeze({
        version: 1,
        profileKey: snapshot.profileKey,
        checkoutFamilyKey: snapshot.checkoutFamilyKey,
        records: Object.freeze(records),
      }),
    });
  } catch {
    return Object.freeze({ invalid: true });
  }
}

function orderedRecord(value: Readonly<Record<string, string>>): Record<string, string> {
  const result: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const key of Object.keys(value).sort()) result[key] = value[key]!;
  return result;
}

function staticHeaders(entry: RawMcpEntry): Record<string, string> {
  if (entry.remote === undefined || Object.keys(entry.remote.rawHeaders).length > 0) {
    return orderedRecord(entry.remote?.rawHeaders ?? {});
  }
  const rawEntry = entry.remote.rawEntry;
  if (rawEntry === undefined) return Object.create(null) as Record<string, string>;
  const descriptor = Object.getOwnPropertyDescriptor(rawEntry, "headers");
  if (descriptor === undefined || !("value" in descriptor) || descriptor.value === undefined) {
    return Object.create(null) as Record<string, string>;
  }
  const value = descriptor.value;
  if (value === null || typeof value !== "object" || Array.isArray(value)) return { "<invalid>": "shape" };
  const result: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const key of Reflect.ownKeys(value).sort((left, right) => String(left) < String(right) ? -1 : String(left) > String(right) ? 1 : 0)) {
    if (typeof key !== "string") return { "<invalid>": "key" };
    const item = Object.getOwnPropertyDescriptor(value, key);
    if (item === undefined || !("value" in item) || typeof item.value !== "string") return { "<invalid>": "value" };
    result[key] = item.value;
  }
  return result;
}

export function staticMcpHeaderCount(entry: RawMcpEntry): number {
  return Object.keys(staticHeaders(entry)).length;
}

function normalizedRemoteIdentity(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    parsed.protocol = parsed.protocol.toLowerCase();
    parsed.hostname = parsed.hostname.toLowerCase();
    if ((parsed.protocol === "https:" && parsed.port === "443") ||
      (parsed.protocol === "http:" && parsed.port === "80")) parsed.port = "";
    return parsed.toString();
  } catch {
    return rawUrl;
  }
}

export function createMcpReviewDefinitionDigest(entry: RawMcpEntry): string | undefined {
  if (entry.skipped || entry.notConfigured) return undefined;
  const definition = entry.remote === undefined
    ? {
        transport: "stdio",
        command: entry.command,
        arguments: [...entry.args],
        environment: orderedRecord(entry.env),
        timeoutMs: entry.timeoutMs ?? null,
      }
    : {
        transport: entry.remote.transportKind,
        type: entry.remote.transportKind,
        endpoint: normalizedRemoteIdentity(entry.remote.rawUrl),
        headers: staticHeaders(entry),
        timeoutMs: entry.timeoutMs ?? null,
      };
  return `mcp-review-v${MCP_REVIEW_DEFINITION_VERSION}:${createHash("sha256").update(JSON.stringify(definition)).digest("hex")}`;
}

export function createMcpReviewIdentity(input: {
  snapshot: Pick<McpReviewSnapshot, "profileKey" | "checkoutFamilyKey">;
  source: McpAdministrationSource;
  serverName: string;
  agentOwner?: McpAgentOwner;
}): McpReviewIdentity {
  return Object.freeze({
    profileKey: input.snapshot.profileKey,
    checkoutFamilyKey: input.snapshot.checkoutFamilyKey,
    source: input.source,
    serverName: input.serverName,
    ...(input.agentOwner === undefined ? {} : { agentOwner: Object.freeze({ ...input.agentOwner }) }),
  });
}

export function commandBasename(command: string): string | undefined {
  const normalized = command.replaceAll("\\", "/");
  const basename = path.posix.basename(normalized).trim();
  return basename === "" ? undefined : basename.slice(0, 128);
}

export function safeRemoteOrigin(rawUrl: string): string | undefined {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return undefined;
    return `${parsed.protocol}//${parsed.host}`.slice(0, 256);
  } catch {
    return undefined;
  }
}

export function matchesMcpReviewRecord(
  record: import("./model.js").McpReviewRecord,
  identity: McpReviewIdentity,
  definitionDigest: string,
): boolean {
  return record.definitionVersion === MCP_REVIEW_DEFINITION_VERSION &&
    record.definitionDigest === definitionDigest &&
    record.profileKey === identity.profileKey &&
    record.checkoutFamilyKey === identity.checkoutFamilyKey &&
    record.source === identity.source &&
    record.serverName === identity.serverName &&
    record.agentOwner?.name === identity.agentOwner?.name &&
    record.agentOwner?.scope === identity.agentOwner?.scope;
}

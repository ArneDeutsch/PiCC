import type {
  AgentMcpDeclaration,
  AgentMcpDiagnosticOwnership,
  AgentMcpItem,
  AgentMcpScope,
  DeepReadonly,
  NormalizedAgentMcpEntry,
} from "../types.js";
import { neutralizeControlChars } from "../util/neutralize-text.js";
import {
  normalizeMcpServerBlock,
  type RawMcpEntry,
} from "./mcp-config.js";

export const AGENT_MCP_LIMITS = Object.freeze({
  items: 128,
  diagnostics: 128,
  diagnosticChars: 192,
  entryFields: 64,
  collectionItems: 64,
  graphNodes: 256,
  stringChars: 8192,
  fieldNameChars: 128,
  headerNameChars: 256,
  serverNameChars: 128,
});

const SOURCE_LABEL = "agent mcpServers declaration";
const STRING_FIELDS = new Set(["command", "type", "url"]);
const SERVER_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;

function canonicalServerName(name: string): string | undefined {
  return name.length <= AGENT_MCP_LIMITS.serverNameChars && SERVER_NAME_RE.test(name) && !name.includes("__")
    ? name
    : undefined;
}

function diagnosticOwnership(
  serverName?: string,
  itemIndex?: number,
): AgentMcpDiagnosticOwnership {
  const ownership = Object.create(null) as {
    kind: "server" | "unowned";
    serverName?: string;
    itemIndex?: number;
  };
  if (serverName !== undefined) {
    ownership.kind = "server";
    ownership.serverName = serverName;
  } else {
    ownership.kind = "unowned";
    if (itemIndex !== undefined) ownership.itemIndex = itemIndex;
  }
  return Object.freeze(ownership) as AgentMcpDiagnosticOwnership;
}

function safeDiagnostic(message: string): string {
  const clean = neutralizeControlChars(message).replace(/[\r\n\t]+/gu, " ");
  return clean.length <= AGENT_MCP_LIMITS.diagnosticChars
    ? clean
    : `${clean.slice(0, AGENT_MCP_LIMITS.diagnosticChars - 1)}…`;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

interface ProjectionBudget {
  nodes: number;
}

type ProjectionFailure = { readonly ok: false; readonly reason: string };
type EntryProjection =
  | { readonly ok: true; readonly value: Record<string, unknown> }
  | ProjectionFailure;

function projectionFailure(reason: string): ProjectionFailure {
  return { ok: false, reason };
}

function takeNode(budget: ProjectionBudget): boolean {
  budget.nodes++;
  return budget.nodes <= AGENT_MCP_LIMITS.graphNodes;
}

function projectString(
  value: unknown,
  field: string,
  budget: ProjectionBudget,
): { readonly ok: true; readonly value: string } | ProjectionFailure {
  if (!takeNode(budget)) {
    return projectionFailure(`exceeds the ${AGENT_MCP_LIMITS.graphNodes}-node projected graph limit`);
  }
  if (typeof value !== "string") {
    return projectionFailure(`has invalid property "${field}" (must be a string)`);
  }
  if (value.length > AGENT_MCP_LIMITS.stringChars) {
    return projectionFailure(`property "${field}" exceeds the ${AGENT_MCP_LIMITS.stringChars}-character string limit`);
  }
  return { ok: true, value };
}

function projectArray(
  value: unknown,
  field: string,
  budget: ProjectionBudget,
): { readonly ok: true; readonly value: string[] } | ProjectionFailure {
  if (!takeNode(budget)) {
    return projectionFailure(`exceeds the ${AGENT_MCP_LIMITS.graphNodes}-node projected graph limit`);
  }
  if (!Array.isArray(value)) {
    return projectionFailure(`has invalid property "${field}" (must be an array of strings)`);
  }
  if (value.length > AGENT_MCP_LIMITS.collectionItems) {
    return projectionFailure(`property "${field}" has more than ${AGENT_MCP_LIMITS.collectionItems} entries`);
  }
  const copy: string[] = [];
  for (let index = 0; index < value.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !("value" in descriptor)) {
      return projectionFailure(`property "${field}" contains an invalid or accessor element`);
    }
    const projected = projectString(descriptor.value, field, budget);
    if (!projected.ok) return projected;
    copy.push(projected.value);
  }
  return { ok: true, value: copy };
}

function projectStringRecord(
  value: unknown,
  field: string,
  nameChars: number,
  budget: ProjectionBudget,
): { readonly ok: true; readonly value: Record<string, string> } | ProjectionFailure {
  if (!takeNode(budget)) {
    return projectionFailure(`exceeds the ${AGENT_MCP_LIMITS.graphNodes}-node projected graph limit`);
  }
  if (!isPlainRecord(value)) {
    return projectionFailure(`has invalid property "${field}" (must be a plain object with string values)`);
  }
  const keys = Object.keys(value);
  if (keys.length > AGENT_MCP_LIMITS.collectionItems) {
    return projectionFailure(`property "${field}" has more than ${AGENT_MCP_LIMITS.collectionItems} entries`);
  }
  const copy = Object.create(null) as Record<string, string>;
  for (const key of keys) {
    if (key.length > nameChars) {
      return projectionFailure(`property "${field}" has a key exceeding the ${nameChars}-character name limit`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor)) {
      return projectionFailure(`property "${field}" contains an accessor property`);
    }
    const projected = projectString(descriptor.value, field, budget);
    if (!projected.ok) return projected;
    copy[key] = projected.value;
  }
  return { ok: true, value: copy };
}

/** Copy only bounded schema leaves. Unknown payloads are never inspected or forwarded. */
function projectEntry(value: unknown): EntryProjection {
  if (!isPlainRecord(value)) return projectionFailure("must contain a plain entry object");
  if (Object.getOwnPropertySymbols(value).length > 0) {
    return projectionFailure("contains invalid symbol properties");
  }
  const keys = Object.keys(value);
  if (keys.length > AGENT_MCP_LIMITS.entryFields) {
    return projectionFailure(`has more than ${AGENT_MCP_LIMITS.entryFields} entry fields`);
  }
  const budget: ProjectionBudget = { nodes: 1 };
  const copy = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    if (key.length > AGENT_MCP_LIMITS.fieldNameChars) {
      return projectionFailure(`has a field name exceeding the ${AGENT_MCP_LIMITS.fieldNameChars}-character limit`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor)) {
      return projectionFailure("contains an accessor entry property");
    }
    if (STRING_FIELDS.has(key)) {
      const projected = projectString(descriptor.value, key, budget);
      if (!projected.ok) return projected;
      copy[key] = projected.value;
    } else if (key === "timeout") {
      if (!takeNode(budget)) {
        return projectionFailure(`exceeds the ${AGENT_MCP_LIMITS.graphNodes}-node projected graph limit`);
      }
      if (typeof descriptor.value !== "number" || !Number.isFinite(descriptor.value)) {
        return projectionFailure('has invalid property "timeout" (must be a finite number)');
      }
      copy[key] = descriptor.value;
    } else if (key === "args") {
      const projected = projectArray(descriptor.value, key, budget);
      if (!projected.ok) return projected;
      copy[key] = projected.value;
    } else if (key === "env" || key === "headers") {
      const projected = projectStringRecord(
        descriptor.value,
        key,
        key === "headers" ? AGENT_MCP_LIMITS.headerNameChars : AGENT_MCP_LIMITS.fieldNameChars,
        budget,
      );
      if (!projected.ok) return projected;
      copy[key] = projected.value;
    } else {
      if (!takeNode(budget)) {
        return projectionFailure(`exceeds the ${AGENT_MCP_LIMITS.graphNodes}-node projected graph limit`);
      }
      copy[key] = null;
    }
  }
  return { ok: true, value: copy };
}

function freezeConfig<T>(value: T, seen = new WeakSet<object>()): DeepReadonly<T> {
  if (value === null || typeof value !== "object") return value as DeepReadonly<T>;
  if (seen.has(value)) return value as DeepReadonly<T>;
  seen.add(value);
  for (const item of Object.values(value)) freezeConfig(item, seen);
  return Object.freeze(value) as DeepReadonly<T>;
}

function normalizeOne(name: string, projectedEntry: unknown): RawMcpEntry {
  const block = Object.create(null) as Record<string, unknown>;
  block[name] = projectedEntry;
  return normalizeMcpServerBlock(block, SOURCE_LABEL)[0]!;
}

function retainedEntry(entry: RawMcpEntry): DeepReadonly<NormalizedAgentMcpEntry> {
  const retained: NormalizedAgentMcpEntry = {
    name: entry.name,
    command: entry.command,
    args: [...entry.args],
    env: Object.assign(Object.create(null) as Record<string, string>, entry.env),
    ...(entry.timeoutMs === undefined ? {} : { timeoutMs: entry.timeoutMs }),
    ...(entry.remote === undefined ? {} : {
      remote: {
        configuredType: entry.remote.configuredType,
        transportKind: entry.remote.transportKind,
        rawUrl: entry.remote.rawUrl,
        ...(entry.remote.rawEntry === undefined ? {} : { rawEntry: entry.remote.rawEntry }),
        rawHeaders: Object.assign(
          Object.create(null) as Record<string, string>,
          entry.remote.rawHeaders,
        ),
        ...(entry.remote.sseDeprecation === undefined
          ? {}
          : { sseDeprecation: { ...entry.remote.sseDeprecation } }),
      },
    }),
    ...(entry.notConfigured === undefined ? {} : { notConfigured: entry.notConfigured }),
    skipped: false,
  };
  return freezeConfig(retained);
}

/** Normalize documented agent `mcpServers` list syntax without admitting or starting servers. */
export function normalizeAgentMcpDeclaration(
  value: unknown,
  scope: AgentMcpScope,
): AgentMcpDeclaration {
  const items: AgentMcpItem[] = [];
  const diagnostics: string[] = [];
  const ownership: AgentMcpDiagnosticOwnership[] = [];
  let omittedDiagnostics = 0;
  const pushDiagnostic = (
    message: string,
    owner: AgentMcpDiagnosticOwnership = diagnosticOwnership(),
  ): void => {
    if (diagnostics.length < AGENT_MCP_LIMITS.diagnostics - 1) {
      diagnostics.push(safeDiagnostic(message));
      ownership.push(owner);
    } else {
      omittedDiagnostics++;
    }
  };

  if (!Array.isArray(value)) {
    pushDiagnostic("Agent mcpServers must be a list of server-name references or one-key inline mappings; declaration ignored");
  } else {
    let count = 0;
    try {
      const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
      const length = lengthDescriptor !== undefined && "value" in lengthDescriptor
        ? lengthDescriptor.value
        : undefined;
      if (typeof length !== "number" || !Number.isSafeInteger(length) || length < 0) {
        pushDiagnostic("Agent mcpServers list shape could not be inspected safely; declaration ignored");
      } else {
        if (length > AGENT_MCP_LIMITS.items) {
          pushDiagnostic(`Agent mcpServers has more than ${AGENT_MCP_LIMITS.items} items; later items ignored`);
        }
        count = Math.min(length, AGENT_MCP_LIMITS.items);
      }
    } catch {
      pushDiagnostic("Agent mcpServers list shape could not be inspected safely; declaration ignored");
    }
    const seenNames = new Set<string>();
    for (let index = 0; index < count; index++) {
      let rawItem: unknown;
      try {
        const itemDescriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (itemDescriptor === undefined || !("value" in itemDescriptor)) {
          pushDiagnostic(`Agent mcpServers item ${index + 1} contains an invalid or accessor element; item ignored`, diagnosticOwnership(undefined, index));
          continue;
        }
        rawItem = itemDescriptor.value;
      } catch {
        pushDiagnostic(`Agent mcpServers item ${index + 1} could not be inspected safely; item ignored`, diagnosticOwnership(undefined, index));
        continue;
      }
      try {
        let kind: "reference" | "inline";
        let rawName: string;
        let rawEntry: unknown;
        if (typeof rawItem === "string") {
          kind = "reference";
          rawName = rawItem;
          rawEntry = { command: "agent-reference-validation-only" };
        } else if (isPlainRecord(rawItem)) {
          if (Object.getOwnPropertySymbols(rawItem).length > 0) {
            pushDiagnostic(`Agent mcpServers item ${index + 1} contains invalid symbol properties; item ignored`, diagnosticOwnership(undefined, index));
            continue;
          }
          const keys = Object.keys(rawItem);
          if (keys.length !== 1) {
            pushDiagnostic(`Agent mcpServers item ${index + 1} must be a one-key mapping; item ignored`, diagnosticOwnership(undefined, index));
            continue;
          }
          const rawNameDescriptor = Object.getOwnPropertyDescriptor(rawItem, keys[0]!);
          if (rawNameDescriptor === undefined || !("value" in rawNameDescriptor)) {
            pushDiagnostic(`Agent mcpServers item ${index + 1} contains an accessor mapping property; item ignored`, diagnosticOwnership(undefined, index));
            continue;
          }
          kind = "inline";
          rawName = keys[0]!;
          rawEntry = rawNameDescriptor.value;
        } else {
          pushDiagnostic(`Agent mcpServers item ${index + 1} must be a string or one-key mapping; item ignored`, diagnosticOwnership(undefined, index));
          continue;
        }

        if (rawName.length > AGENT_MCP_LIMITS.serverNameChars) {
          pushDiagnostic(`Agent mcpServers item ${index + 1} has a server name exceeding the 128-character limit; item ignored`, diagnosticOwnership(undefined, index));
          continue;
        }

        const knownName = canonicalServerName(rawName);
        const findingOwner = diagnosticOwnership(knownName, index);
        const projection = projectEntry(rawEntry);
        if (!projection.ok) {
          pushDiagnostic(`Agent mcpServers item ${index + 1} ${projection.reason}; item ignored`, findingOwner);
          continue;
        }
        const normalized = normalizeOne(rawName, projection.value);
        for (const diagnostic of normalized.diagnostics) pushDiagnostic(diagnostic, findingOwner);
        if (normalized.skipped) continue;
        if (seenNames.has(normalized.name)) {
          pushDiagnostic(`Duplicate agent MCP server name ${JSON.stringify(normalized.name)} at item ${index + 1}; first valid occurrence retained`, diagnosticOwnership(normalized.name));
          continue;
        }
        seenNames.add(normalized.name);
        items.push(kind === "reference"
          ? Object.freeze({ kind, name: normalized.name })
          : Object.freeze({ kind, name: normalized.name, entry: retainedEntry(normalized) }));
      } catch {
        pushDiagnostic(`Agent mcpServers item ${index + 1} could not be normalized safely; item ignored`, diagnosticOwnership(undefined, index));
      }
    }
  }

  if (omittedDiagnostics > 0) {
    diagnostics.push(safeDiagnostic(`Additional agent MCP diagnostics omitted (${omittedDiagnostics})`));
    ownership.push(diagnosticOwnership());
  }
  return Object.freeze({
    scope,
    items: Object.freeze(items),
    diagnostics: Object.freeze(diagnostics),
    diagnosticOwnership: Object.freeze(ownership),
  });
}

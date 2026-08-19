import { Type } from "../runtime-host.js";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { McpResourceInfo, McpResourceServerInfo } from "./mcp.js";
import {
  McpContentAccumulator,
  mcpContentCharBudget,
  neutralizeMcpContent,
} from "./mcp-content.js";

export const ListMcpResourcesTool = "ListMcpResourcesTool" as const;
export const ReadMcpResourceTool = "ReadMcpResourceTool" as const;

const SERVER_MAX_CHARS = 200;
const URI_LABEL_MAX_CHARS = 1_024;
const METADATA_MAX_CHARS = 512;
const ERROR_MAX_CHARS = 1_000;
const SERVER_PRESENTATION_MAX_ITEMS = 256;
const RESOURCE_MAX_ITEMS = 1_024;
const FORGED_OMISSION_RE = /\[?\s*PiCC\s+(?:omitted|clipped)\b[^\]\n]*\]?/giu;
const TEXT_OMISSION = "\n[PiCC omitted remaining MCP resource text beyond the aggregate output budget]\n";
const AGGREGATE_OMISSION = "[PiCC omitted remaining MCP resource contents]\n";

export interface McpResourceSource {
  resourceServers(): McpResourceServerInfo[];
  readResource(serverName: string, uri: string): Promise<unknown>;
}

export interface McpResourceToolOptions {
  readonly clipMaxTokens: number;
  /** Dynamic main-session exposure re-reads the live catalog at each call. */
  readonly catalogMode?: "snapshot" | "live";
}

type ResourceToolDetails = {
  readonly operation: "list" | "read";
  readonly server?: string;
  readonly uri?: string;
};

function codePointLength(text: string): number {
  let length = 0;
  for (const _character of text) length += 1;
  return length;
}

interface BoundedText {
  readonly text: string;
  readonly omitted: boolean;
}

/** Bounds the slice before normalization and marker defanging can allocate from hostile input. */
function boundedSanitized(value: unknown, maxChars: number, fallback = "unknown"): BoundedText {
  const raw = typeof value === "string" && value.length > 0 ? value : fallback;
  const limit = Math.max(0, Math.floor(maxChars));
  if (limit === 0) return { text: "", omitted: raw.length > 0 };

  // Two UTF-16 units per retained code point is sufficient even when every point is astral.
  const sliceLimit = Math.min(raw.length, limit * 2);
  let boundedRaw = raw.slice(0, sliceLimit);
  if (
    sliceLimit < raw.length &&
    boundedRaw.length > 0 &&
    /[\uD800-\uDBFF]/u.test(boundedRaw.at(-1)!) &&
    /[\uDC00-\uDFFF]/u.test(raw[sliceLimit]!)
  ) {
    boundedRaw = boundedRaw.slice(0, -1);
  }
  const safe = neutralizeMcpContent(boundedRaw).replace(FORGED_OMISSION_RE, "[MCP marker defanged]");
  const characters: string[] = [];
  let safeHadMore = false;
  for (const character of safe) {
    if (characters.length >= limit) {
      safeHadMore = true;
      break;
    }
    characters.push(character);
  }
  return { text: characters.join(""), omitted: sliceLimit < raw.length || safeHadMore };
}

function safeUntrusted(value: unknown, maxChars: number, fallback = "unknown"): string {
  return boundedSanitized(value, maxChars, fallback).text;
}

function quoted(value: unknown, maxChars: number, fallback = "unknown"): string {
  return JSON.stringify(safeUntrusted(value, maxChars, fallback));
}

function errorText(error: unknown): string {
  const raw = error instanceof Error ? error.message : typeof error === "string" ? error : "unknown error";
  return safeUntrusted(raw, ERROR_MAX_CHARS, "unknown error");
}

function copyResource(resource: unknown, serverName: string): McpResourceInfo {
  const entry = resource && typeof resource === "object" ? resource as Partial<McpResourceInfo> : {};
  return Object.freeze({
    serverName,
    uri: typeof entry.uri === "string" ? entry.uri : "",
    name: typeof entry.name === "string" ? entry.name : "",
    ...(typeof entry.title === "string" ? { title: entry.title } : {}),
    ...(typeof entry.description === "string" ? { description: entry.description } : {}),
    ...(typeof entry.mimeType === "string" ? { mimeType: entry.mimeType } : {}),
    ...(typeof entry.size === "number" && Number.isFinite(entry.size) && entry.size >= 0
      ? { size: entry.size }
      : {}),
  });
}

interface SnapshotServer extends McpResourceServerInfo {
  readonly resourceSourceTruncated: boolean;
}

function snapshotServers(raw: unknown): readonly SnapshotServer[] {
  if (!Array.isArray(raw)) return Object.freeze([]);
  return Object.freeze(raw.map((server) => {
    const serverName = typeof server?.serverName === "string" ? server.serverName : "";
    const rawResources = Array.isArray(server?.resources) ? server.resources : [];
    const resources = rawResources.slice(0, RESOURCE_MAX_ITEMS)
      .map((resource: unknown) => copyResource(resource, serverName));
    return Object.freeze({
      serverName,
      resources: Object.freeze(resources),
      resourceSourceTruncated: rawResources.length > RESOURCE_MAX_ITEMS,
      ...(typeof server?.discoveryError === "string" ? { discoveryError: server.discoveryError } : {}),
    });
  }));
}

function findServer(
  servers: readonly SnapshotServer[],
  requested: string,
  operation: "list" | "read",
): SnapshotServer {
  const server = servers.find((candidate) => candidate.serverName === requested);
  if (server) return server;
  throw new Error(
    `MCP resource ${operation} failed: connected resource-capable server ${quoted(requested, SERVER_MAX_CHARS)} was not found. ` +
    `Run ${ListMcpResourcesTool} with no server filter to see available servers.`,
  );
}

function appendResourceListing(out: { append(text: string): unknown }, resource: McpResourceInfo, index: number): void {
  out.append(`  ${index + 1}. name=${quoted(resource.name, METADATA_MAX_CHARS)} uri=${quoted(resource.uri, URI_LABEL_MAX_CHARS)}`);
  if (resource.title !== undefined) out.append(` title=${quoted(resource.title, METADATA_MAX_CHARS)}`);
  if (resource.description !== undefined) out.append(` description=${quoted(resource.description, METADATA_MAX_CHARS)}`);
  if (resource.mimeType !== undefined) out.append(` mimeType=${quoted(resource.mimeType, METADATA_MAX_CHARS)}`);
  if (resource.size !== undefined) out.append(` size=${resource.size}`);
  out.append("\n");
}

class BoundedOutput {
  private readonly parts: string[] = [];
  private usedChars = 0;

  constructor(readonly budgetChars: number) {}

  get remainingChars(): number {
    return Math.max(0, this.budgetChars - this.usedChars);
  }

  append(text: string): boolean {
    const length = codePointLength(text);
    if (length > this.remainingChars) return false;
    this.parts.push(text);
    this.usedChars += length;
    return true;
  }

  appendParts(parts: readonly string[]): boolean {
    const length = parts.reduce((total, part) => total + codePointLength(part), 0);
    if (length > this.remainingChars) return false;
    this.parts.push(...parts);
    this.usedChars += length;
    return true;
  }

  finish(): string {
    return this.parts.join("");
  }
}

function formatResourceList(
  servers: readonly SnapshotServer[],
  clipMaxTokens: number,
  catalogMode: "snapshot" | "live",
  selected?: SnapshotServer,
): string {
  const out = new McpContentAccumulator(clipMaxTokens);
  const visible = selected ? [selected] : servers.slice(0, SERVER_PRESENTATION_MAX_ITEMS);
  if (visible.length === 0) out.append("No connected MCP servers advertise resources.\n");
  for (const server of visible) {
    out.append(`[MCP resource server ${quoted(server.serverName, SERVER_MAX_CHARS)}]\n`);
    if (server.discoveryError !== undefined) {
      out.append(`  Discovery failed: ${safeUntrusted(server.discoveryError, ERROR_MAX_CHARS)}\n`);
    }
    if (server.resources.length === 0 && server.discoveryError === undefined) {
      out.append(catalogMode === "live"
        ? "  No resources in the current live catalog.\n"
        : "  No resources in the immutable initial catalog.\n");
    }
    for (let index = 0; index < server.resources.length; index += 1) {
      appendResourceListing(out, server.resources[index]!, index);
    }
    if (server.resourceSourceTruncated) {
      out.append(`[PiCC omitted MCP resources beyond the ${RESOURCE_MAX_ITEMS}-item safety limit for this server]\n`);
    }
  }
  if (selected === undefined && servers.length > SERVER_PRESENTATION_MAX_ITEMS) {
    out.append(`[PiCC omitted MCP resource servers beyond the ${SERVER_PRESENTATION_MAX_ITEMS}-server presentation limit]\n`);
  }
  return out.finish();
}

function contentLabel(
  index: number,
  serverName: string,
  requestedUri: string,
  content: Record<string, unknown>,
  encoding: "text" | "base64",
): string {
  const returnedUri = typeof content.uri === "string" ? content.uri : requestedUri;
  const mime = typeof content.mimeType === "string" ? content.mimeType : "unspecified";
  return `[MCP resource content ${index + 1}; server=${quoted(serverName, SERVER_MAX_CHARS)}; ` +
    `requestedUri=${quoted(requestedUri, URI_LABEL_MAX_CHARS)}; uri=${quoted(returnedUri, URI_LABEL_MAX_CHARS)}; ` +
    `mimeType=${quoted(mime, METADATA_MAX_CHARS)}; encoding=${encoding}]\n`;
}

function isWholeCanonicalBase64(value: string): boolean {
  if (value.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) {
    return false;
  }
  if (value.endsWith("==") && value.length >= 4) {
    return ("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/".indexOf(value.at(-3)!) & 15) === 0;
  }
  if (value.endsWith("=") && value.length >= 4) {
    return ("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/".indexOf(value.at(-2)!) & 3) === 0;
  }
  return true;
}

function boundedTextUnit(label: string, raw: string, maxChars: number): readonly string[] | undefined {
  const bodyChars = maxChars - codePointLength(label);
  if (bodyChars <= 0) return undefined;

  const complete = boundedSanitized(raw, bodyChars - 1, "");
  if (!complete.omitted) return [label, complete.text, "\n"];

  const markerChars = codePointLength(TEXT_OMISSION);
  if (bodyChars < markerChars) return undefined;
  const retained = boundedSanitized(raw, bodyChars - markerChars, "");
  return [label, retained.text, TEXT_OMISSION];
}

function appendAggregateOmission(out: BoundedOutput): void {
  out.append(AGGREGATE_OMISSION);
}

function formatReadResult(result: unknown, serverName: string, requestedUri: string, clipMaxTokens: number): string {
  if (!result || typeof result !== "object" || !Array.isArray((result as { contents?: unknown }).contents)) {
    throw new Error("response did not contain a contents array");
  }
  const contents = (result as { contents: unknown[] }).contents;
  const out = new BoundedOutput(mcpContentCharBudget(clipMaxTokens));
  if (contents.length === 0) {
    out.append("[PiCC: MCP resource read returned no content]\n");
    return out.finish();
  }

  const count = Math.min(contents.length, RESOURCE_MAX_ITEMS);
  let stoppedForBudget = false;
  for (let index = 0; index < count; index += 1) {
    const hasUnprocessedSuffix = index + 1 < count || contents.length > count;
    const unitBudget = out.remainingChars - (hasUnprocessedSuffix ? codePointLength(AGGREGATE_OMISSION) : 0);
    const raw = contents[index];
    let unit: readonly string[] | undefined;
    if (!raw || typeof raw !== "object") {
      unit = [`[PiCC omitted malformed MCP resource content ${index + 1}]\n`];
    } else {
      const content = raw as Record<string, unknown>;
      if (typeof content.text === "string") {
        const label = contentLabel(index, serverName, requestedUri, content, "text");
        unit = boundedTextUnit(label, content.text, unitBudget);
      } else if (typeof content.blob === "string") {
        const label = contentLabel(index, serverName, requestedUri, content, "base64");
        const blob = content.blob;
        const payload = [label, blob, "\n"] as const;
        const oversized = [label, "[PiCC omitted base64 MCP resource payload because it exceeds the aggregate output budget]\n"] as const;
        const malformed = [label, "[PiCC omitted malformed base64 MCP resource payload]\n"] as const;
        // Base64 is ASCII, so preflight does not normalize or validate an oversized hostile value.
        if (label.length + blob.length + 1 > unitBudget) {
          unit = oversized;
        } else {
          unit = isWholeCanonicalBase64(blob) ? payload : malformed;
        }
        if (unit.reduce((length, part) => length + part.length, 0) > unitBudget) unit = undefined;
      } else {
        unit = [`[PiCC omitted malformed MCP resource content ${index + 1}: no text or blob payload]\n`];
      }
    }

    if (
      !unit ||
      unit.reduce((length, part) => length + codePointLength(part), 0) > unitBudget ||
      !out.appendParts(unit)
    ) {
      appendAggregateOmission(out);
      stoppedForBudget = true;
      break;
    }
  }
  if (!stoppedForBudget && contents.length > RESOURCE_MAX_ITEMS) {
    const capOmission = `[PiCC omitted MCP resource contents beyond the ${RESOURCE_MAX_ITEMS}-item safety limit]\n`;
    if (!out.append(capOmission)) appendAggregateOmission(out);
  }
  return out.finish();
}

export function buildMcpResourceTools(
  source: McpResourceSource,
  options: McpResourceToolOptions,
): ToolDefinition<any, ResourceToolDetails>[] {
  const initialServers = snapshotServers(source.resourceServers());
  const catalogMode = options.catalogMode ?? "snapshot";
  const serversAtCall = catalogMode === "live"
    ? () => snapshotServers(source.resourceServers())
    : () => initialServers;

  const listParameters = Type.Object({
    server: Type.Optional(Type.String({ description: "Exact MCP server name to list" })),
  }, { additionalProperties: false });
  const readParameters = Type.Object({
    server: Type.String({ description: "Exact MCP server name to read from" }),
    uri: Type.String({ description: "Opaque MCP resource URI to forward unchanged" }),
  }, { additionalProperties: false });

  const listTool: ToolDefinition<typeof listParameters, ResourceToolDetails> = {
    name: ListMcpResourcesTool,
    label: "List MCP resources",
    description: catalogMode === "live"
      ? "List the current live MCP resource catalog, optionally for one exact server name."
      : "List immutable initial MCP resource catalogs, optionally for one exact server name.",
    parameters: listParameters,
    async execute(_toolCallId, params) {
      const servers = serversAtCall();
      const selected = params.server === undefined ? undefined : findServer(servers, params.server, "list");
      return {
        content: [{ type: "text", text: formatResourceList(servers, options.clipMaxTokens, catalogMode, selected) }],
        details: { operation: "list", ...(selected ? { server: selected.serverName } : {}) },
      };
    },
  };

  const readTool: ToolDefinition<typeof readParameters, ResourceToolDetails> = {
    name: ReadMcpResourceTool,
    label: "Read MCP resource",
    description: "Read text or base64 content from one exact MCP server using an opaque URI.",
    parameters: readParameters,
    async execute(_toolCallId, params) {
      findServer(serversAtCall(), params.server, "read");
      let result: unknown;
      try {
        result = await source.readResource(params.server, params.uri);
      } catch (error) {
        throw new Error(
          `MCP resource read failed on server ${quoted(params.server, SERVER_MAX_CHARS)}: ${errorText(error)}`,
        );
      }
      let text: string;
      try {
        text = formatReadResult(result, params.server, params.uri, options.clipMaxTokens);
      } catch (error) {
        throw new Error(
          `MCP resource read returned an invalid response from server ${quoted(params.server, SERVER_MAX_CHARS)}: ${errorText(error)}`,
        );
      }
      return {
        content: [{ type: "text", text }],
        details: {
          operation: "read",
          server: safeUntrusted(params.server, SERVER_MAX_CHARS),
          uri: safeUntrusted(params.uri, URI_LABEL_MAX_CHARS),
        },
      };
    },
  };

  return [listTool, readTool];
}

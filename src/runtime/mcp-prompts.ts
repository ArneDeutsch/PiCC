import { defangClipMarker } from "../util/clip-middle.js";
import type { McpPromptArgumentInfo, McpPromptInfo } from "./mcp.js";
import {
  boundedMcpErrorText,
  McpContentAccumulator,
  neutralizeMcpContent,
} from "./mcp-content.js";

const COMPONENT_MAX_CHARS = 100;
const DESCRIPTION_MAX_CHARS = 2_048;
const ARGUMENT_NAME_MAX_CHARS = 200;
const ARGUMENT_HINT_MAX_CHARS = 2_048;
const ARGUMENT_COUNT_MAX = 1_024;
const INVOCATION_MAX_CHARS = 8_192;
const ARGUMENT_VALUE_MAX_CHARS = 8_192;
const DIAGNOSTIC_MAX_CHARS = 1_000;
const DIAGNOSTIC_MAX_COUNT = 100;
const MATCH_DISPLAY_MAX_CHARS = 240;
const UNSAFE_METADATA_RE = /[\p{Cc}\p{Cf}]/u;
const UNSAFE_NAME_RE = /[^A-Za-z0-9_-]/g;
const MCP_OMISSION_MARKER_RE = /\[?\s*PiCC\s+omitted\b[^\]\n]*\]?/iu;

export interface McpPromptCommand {
  readonly name: string;
  readonly serverName: string;
  readonly promptName: string;
  readonly description: string;
  readonly argumentHint: string;
  readonly arguments: readonly McpPromptArgumentInfo[];
}

export interface McpPromptCatalog {
  readonly commands: readonly McpPromptCommand[];
  readonly diagnostics: readonly string[];
}

export class McpPromptCatalogStore {
  private catalogValue: McpPromptCatalog;

  constructor(private readonly reservedNames: () => ReadonlySet<string> | readonly string[]) {
    this.catalogValue = buildMcpPromptCatalog([], this.reservedNames());
  }

  current(): McpPromptCatalog {
    return this.catalogValue;
  }

  refresh(prompts: readonly McpPromptInfo[]): McpPromptCatalog {
    this.catalogValue = buildMcpPromptCatalog(prompts, this.reservedNames());
    return this.catalogValue;
  }
}

interface McpPromptRoutingState {
  readonly byName: ReadonlyMap<string, McpPromptCommand>;
  readonly reservedNames: ReadonlySet<string>;
}

const routingByCatalog = new WeakMap<McpPromptCatalog, McpPromptRoutingState>();

export type McpPromptMatch =
  | { readonly kind: "known"; readonly command: McpPromptCommand; readonly argumentText: string }
  | { readonly kind: "reserved"; readonly name: string }
  | { readonly kind: "unknown"; readonly name: string; readonly error: string };

export interface McpPromptSource {
  getPrompt(serverName: string, promptName: string, args: Record<string, string>): Promise<unknown>;
}

export type McpPromptInvocationErrorCategory = "arguments" | "call" | "response";

export class McpPromptInvocationError extends Error {
  readonly category: McpPromptInvocationErrorCategory;

  constructor(category: McpPromptInvocationErrorCategory, message: string) {
    super(boundedMcpErrorText(message, DIAGNOSTIC_MAX_CHARS));
    this.name = "McpPromptInvocationError";
    this.category = category;
  }
}

function cpLength(text: string): number {
  return Array.from(text).length;
}

function lexicalCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function clipMetadata(text: unknown, maxChars: number): string {
  if (typeof text !== "string") return "";
  return Array.from(neutralizeMcpContent(text)).slice(0, maxChars).join("");
}

function normalizeComponent(raw: unknown): string | undefined {
  if (typeof raw !== "string" || raw.length === 0) return undefined;
  const normalized = raw.replace(UNSAFE_NAME_RE, "_");
  const length = cpLength(normalized);
  return length > 0 && length <= COMPONENT_MAX_CHARS ? normalized : undefined;
}

type ArgumentListResult =
  | { readonly kind: "accepted"; readonly arguments: readonly McpPromptArgumentInfo[] }
  | { readonly kind: "unsafe" }
  | { readonly kind: "unsupported-order" };

function safeArgumentList(args: unknown): ArgumentListResult {
  if (!Array.isArray(args) || args.length > ARGUMENT_COUNT_MAX) return { kind: "unsafe" };
  const seen = new Set<string>();
  const out: McpPromptArgumentInfo[] = [];
  let sawOptional = false;
  for (const raw of args) {
    if (!raw || typeof raw !== "object") return { kind: "unsafe" };
    const argument = raw as Partial<McpPromptArgumentInfo>;
    if (
      typeof argument.name !== "string" || argument.name.length === 0 ||
      cpLength(argument.name) > ARGUMENT_NAME_MAX_CHARS ||
      UNSAFE_METADATA_RE.test(argument.name) || defangClipMarker(argument.name) !== argument.name ||
      MCP_OMISSION_MARKER_RE.test(argument.name) || seen.has(argument.name) ||
      typeof argument.required !== "boolean"
    ) return { kind: "unsafe" };
    if (argument.required && sawOptional) return { kind: "unsupported-order" };
    if (!argument.required) sawOptional = true;
    seen.add(argument.name);
    out.push(Object.freeze({
      name: argument.name,
      description: clipMetadata(argument.description, DESCRIPTION_MAX_CHARS),
      required: argument.required,
    }));
  }
  return { kind: "accepted", arguments: Object.freeze(out) };
}

function argumentHint(args: readonly McpPromptArgumentInfo[]): string | undefined {
  const complete = args
    .map((argument) => argument.required ? `<${argument.name}>` : `[${argument.name}]`)
    .join(" ");
  return cpLength(complete) <= ARGUMENT_HINT_MAX_CHARS ? complete : undefined;
}

function diagnostic(text: string): string {
  return clipMetadata(text, DIAGNOSTIC_MAX_CHARS);
}

function matchDisplayName(name: string): string {
  return clipMetadata(name, MATCH_DISPLAY_MAX_CHARS) || "unknown";
}

export function buildMcpPromptCatalog(
  prompts: readonly McpPromptInfo[],
  reservedNames: ReadonlySet<string> | readonly string[],
): McpPromptCatalog {
  const reserved = new Set(Array.from(reservedNames, (name) => name.startsWith("/") ? name.slice(1) : name));
  const groups = new Map<string, McpPromptCommand[]>();
  let genericRejectionCount = 0;
  let unsupportedOrderCount = 0;
  let oversizedHintCount = 0;

  for (const prompt of prompts) {
    const server = normalizeComponent(prompt?.serverName);
    const name = normalizeComponent(prompt?.promptName);
    const argumentResult = safeArgumentList(prompt?.arguments);
    if (argumentResult.kind === "unsupported-order") {
      unsupportedOrderCount += 1;
      continue;
    }
    const args = argumentResult.kind === "accepted" ? argumentResult.arguments : undefined;
    if (!server || !name || !args) {
      genericRejectionCount += 1;
      continue;
    }
    const hint = argumentHint(args);
    if (hint === undefined) {
      oversizedHintCount += 1;
      continue;
    }
    const commandName = `mcp__${server}__${name}`;
    const command = Object.freeze({
      name: commandName,
      serverName: prompt.serverName,
      promptName: prompt.promptName,
      description: clipMetadata(prompt.description, DESCRIPTION_MAX_CHARS),
      argumentHint: hint,
      arguments: args,
    });
    const candidates = groups.get(commandName) ?? [];
    candidates.push(command);
    groups.set(commandName, candidates);
  }

  const commands: McpPromptCommand[] = [];
  const retainedReserved = new Set([...reserved].filter((name) => name.startsWith("mcp__")));
  const priorityDiagnostics: string[] = [];
  for (const name of [...groups.keys()].sort(lexicalCompare)) {
    const candidates = groups.get(name)!;
    if (candidates.length > 1) {
      priorityDiagnostics.push(diagnostic(`Dropped colliding MCP prompt command /${name}.`));
      if (reserved.has(name)) retainedReserved.add(name);
      continue;
    }
    if (reserved.has(name)) {
      retainedReserved.add(name);
      priorityDiagnostics.push(diagnostic(`Local command /${name} takes precedence over a colliding MCP prompt.`));
      continue;
    }
    commands.push(candidates[0]!);
  }
  commands.sort((left, right) => lexicalCompare(left.name, right.name));
  priorityDiagnostics.sort(lexicalCompare);
  const unsupportedOrderDiagnostic = unsupportedOrderCount > 0
    ? diagnostic(
      `Dropped ${unsupportedOrderCount} MCP prompt command(s) with unsupported positional argument order (optional before required).`,
    )
    : undefined;
  const oversizedHintDiagnostic = oversizedHintCount > 0
    ? diagnostic(
      `Dropped ${oversizedHintCount} MCP prompt command(s) whose complete argument hint exceeds ${ARGUMENT_HINT_MAX_CHARS} characters.`,
    )
    : undefined;
  const genericDiagnostic = genericRejectionCount > 0
    ? diagnostic(`Dropped ${genericRejectionCount} MCP prompt command(s) with unsafe metadata.`)
    : undefined;
  const aggregateDiagnostics = [unsupportedOrderDiagnostic, oversizedHintDiagnostic]
    .filter((entry): entry is string => entry !== undefined);
  const priorityLimit = DIAGNOSTIC_MAX_COUNT - aggregateDiagnostics.length;
  const boundedDiagnostics = priorityDiagnostics.slice(0, priorityLimit);
  if (priorityDiagnostics.length > priorityLimit && priorityLimit > 0) {
    boundedDiagnostics[priorityLimit - 1] = diagnostic(
      `MCP prompt catalog diagnostics truncated at ${DIAGNOSTIC_MAX_COUNT} entries.`,
    );
  }
  boundedDiagnostics.push(...aggregateDiagnostics);
  if (genericDiagnostic && boundedDiagnostics.length < DIAGNOSTIC_MAX_COUNT) {
    boundedDiagnostics.push(genericDiagnostic);
  }
  const frozenCommands = Object.freeze(commands);
  const catalog: McpPromptCatalog = Object.freeze({
    commands: frozenCommands,
    diagnostics: Object.freeze(boundedDiagnostics),
  });
  routingByCatalog.set(catalog, {
    byName: new Map(frozenCommands.map((command) => [command.name, command])),
    reservedNames: retainedReserved,
  });
  return catalog;
}

export function matchMcpPromptInvocation(
  input: string,
  catalog: McpPromptCatalog,
): McpPromptMatch | undefined {
  if (!input.startsWith("/")) return undefined;
  const tokenEnd = input.search(/\s/u);
  const token = input.slice(1, tokenEnd < 0 ? undefined : tokenEnd);
  if (!token.startsWith("mcp__")) return undefined;
  const routing = routingByCatalog.get(catalog);
  if (!routing) return undefined;
  if (routing.reservedNames.has(token)) return { kind: "reserved", name: matchDisplayName(token) };
  const command = routing.byName.get(token);
  if (command) {
    return {
      kind: "known",
      command,
      argumentText: tokenEnd < 0 ? "" : input.slice(tokenEnd).trimStart(),
    };
  }
  if (catalog.commands.length === 0) return undefined;
  const displayName = matchDisplayName(token);
  return {
    kind: "unknown",
    name: displayName,
    error: diagnostic(`Unknown MCP prompt command: /${displayName}`),
  };
}

export function tokenizeMcpPromptArguments(input: string): string[] {
  if (cpLength(input) > INVOCATION_MAX_CHARS) throw new Error("MCP prompt arguments exceed the safe length limit.");
  const values: string[] = [];
  let value = "";
  let quote: "'" | '"' | undefined;
  let started = false;
  let escaping = false;
  for (const character of input) {
    if (escaping) {
      value += character;
      started = true;
      escaping = false;
      continue;
    }
    if (character === "\\") {
      escaping = true;
      started = true;
      continue;
    }
    if (quote) {
      if (character === quote) quote = undefined;
      else value += character;
      started = true;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      started = true;
      continue;
    }
    if (/\s/u.test(character)) {
      if (started) {
        values.push(value);
        value = "";
        started = false;
      }
      continue;
    }
    value += character;
    started = true;
    if (cpLength(value) > ARGUMENT_VALUE_MAX_CHARS) throw new Error("An MCP prompt argument exceeds the safe length limit.");
  }
  if (escaping) throw new Error("MCP prompt arguments end with an unmatched escape.");
  if (quote) throw new Error(`MCP prompt arguments contain an unmatched ${quote === "'" ? "single" : "double"} quote.`);
  if (started) values.push(value);
  return values;
}

export function mapMcpPromptArguments(
  command: McpPromptCommand,
  argumentText: string,
): Record<string, string> {
  const values = tokenizeMcpPromptArguments(argumentText);
  if (values.length > command.arguments.length) {
    throw new Error(`MCP prompt /${command.name} received ${values.length - command.arguments.length} surplus argument(s).`);
  }
  const missing = command.arguments
    .slice(values.length)
    .filter((argument) => argument.required)
    .map((argument) => argument.name);
  if (missing.length > 0) {
    const prefix = `MCP prompt /${command.name} is missing required argument${missing.length === 1 ? "" : "s"}: `;
    const complete = `${prefix}${missing.join(", ")}.`;
    if (cpLength(complete) <= DIAGNOSTIC_MAX_CHARS) throw new Error(complete);

    const retained: string[] = [];
    for (const name of missing) {
      const omitted = missing.length - retained.length - 1;
      const suffix = `; ${omitted} required argument name(s) omitted (diagnostic truncated). ` +
        `See the full command argument hint for /${command.name}.`;
      const candidate = `${prefix}${[...retained, name].join(", ")}${suffix}`;
      if (cpLength(candidate) > DIAGNOSTIC_MAX_CHARS) break;
      retained.push(name);
    }
    const omitted = missing.length - retained.length;
    const suffix = `; ${omitted} required argument name(s) omitted (diagnostic truncated). ` +
      `See the full command argument hint for /${command.name}.`;
    throw new Error(`${prefix}${retained.join(", ")}${suffix}`);
  }
  const mapped = Object.create(null) as Record<string, string>;
  values.forEach((value, index) => {
    mapped[command.arguments[index]!.name] = value;
  });
  return mapped;
}

function contentBlocks(content: unknown): unknown[] | undefined {
  if (Array.isArray(content)) return content;
  return content && typeof content === "object" ? [content] : undefined;
}

function appendBlock(out: McpContentAccumulator, block: unknown): void {
  if (!block || typeof block !== "object") {
    out.append("[PiCC omitted malformed MCP prompt content]\n");
    return;
  }
  const value = block as Record<string, unknown>;
  if (value.type === "text" && typeof value.text === "string") {
    out.append(value.text);
    out.append("\n");
    return;
  }
  if (value.type === "resource" && value.resource && typeof value.resource === "object") {
    const resource = value.resource as Record<string, unknown>;
    if (typeof resource.text === "string") {
      out.append(resource.text);
      out.append("\n");
      return;
    }
    out.append("[PiCC omitted unsupported binary MCP prompt resource content]\n");
    return;
  }
  const type = typeof value.type === "string" ? clipMetadata(value.type, 80) : "unknown";
  out.append(`[PiCC omitted unsupported MCP prompt content: ${type}]\n`);
}

export function convertMcpPromptResult(result: unknown, clipMaxTokens: number): string {
  if (!result || typeof result !== "object" || !Array.isArray((result as { messages?: unknown }).messages)) {
    throw new Error("MCP prompt returned a malformed response without a messages array.");
  }
  const messages = (result as { messages: unknown[] }).messages;
  const out = new McpContentAccumulator(clipMaxTokens);
  for (const raw of messages) {
    if (!raw || typeof raw !== "object") {
      out.append("[PiCC omitted malformed MCP prompt message]\n");
      continue;
    }
    const message = raw as Record<string, unknown>;
    if (message.role !== "user" && message.role !== "assistant") {
      out.append("[PiCC omitted MCP prompt message with an unsupported role]\n");
      continue;
    }
    out.append(`[Untrusted MCP prompt message; protocol role=${message.role}]\n`);
    const blocks = contentBlocks(message.content);
    if (!blocks) {
      out.append("[PiCC omitted malformed MCP prompt content]\n");
      continue;
    }
    for (const block of blocks) appendBlock(out, block);
  }
  return out.finish();
}

export async function invokeMcpPrompt(
  source: McpPromptSource,
  command: McpPromptCommand,
  argumentText: string,
  clipMaxTokens: number,
): Promise<string> {
  let args: Record<string, string>;
  try {
    args = mapMcpPromptArguments(command, argumentText);
  } catch (error) {
    const detail = boundedMcpErrorText(error);
    throw new McpPromptInvocationError(
      "arguments",
      detail.startsWith("MCP prompt /")
        ? detail
        : `MCP prompt /${matchDisplayName(command.name)} arguments invalid: ${detail}`,
    );
  }

  let result: unknown;
  try {
    result = await source.getPrompt(command.serverName, command.promptName, args);
  } catch (error) {
    throw new McpPromptInvocationError(
      "call",
      `MCP prompt /${matchDisplayName(command.name)} failed: ${boundedMcpErrorText(error)}`,
    );
  }

  try {
    return convertMcpPromptResult(result, clipMaxTokens);
  } catch (error) {
    throw new McpPromptInvocationError(
      "response",
      `MCP prompt /${matchDisplayName(command.name)} returned an invalid response: ${boundedMcpErrorText(error)}`,
    );
  }
}

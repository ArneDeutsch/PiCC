import { Compile } from "typebox/compile";
import type { TSchema } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { neutralizeControlChars } from "../util/neutralize-text.js";
import type { McpRuntime } from "./mcp.js";

/**
 * MCP proxy-tool builder: turns a runtime's connected-server tool metadata into
 * Pi `ToolDefinition`s named `mcp__<server>__<tool>` whose execute delegates to
 * `McpRuntime.callTool`. Consumed by the main-session registration in index.ts
 * and per-dispatch by the subagent path — called fresh wherever instances are
 * needed.
 *
 * HARD INVARIANT: no proxy ever sets `promptSnippet` or `promptGuidelines` —
 * Pi rebuilds the base system prompt from tool prompt snippets on registration,
 * so either field would add MCP context to every session and break the
 * zero-context guarantee.
 */

/**
 * Serialized-schema cap. Pi serializes `parameters` verbatim onto every model
 * request, so an unbounded server schema rides every turn; past this the proxy
 * degrades to the permissive schema (the server validates its own args anyway).
 */
const SCHEMA_MAX_CHARS = 32_768;
/**
 * Registered-name bound: OpenAI rejects a function name longer than 64 chars
 * with a request-level 400, so ONE over-long registered name would wedge every
 * subsequent model request with no pointer to the culprit. An over-long
 * `mcp__<server>__<tool>` drops the tool with a diagnostic instead.
 */
const WIRE_NAME_MAX_CHARS = 64;
/** Bound on a tool name/value quoted inside a diagnostic (mirrors mcp.ts's sliceForDiag). */
const DIAG_NAME_MAX_CHARS = 200;

/**
 * Bounded, neutralized quoting of a name or value inside a diagnostic. Unlike
 * runtime/mcp.ts's bound-only sliceForDiag (that module neutralizes once at
 * its diagnostic store), this one neutralizes inline: its outputs feed several
 * sinks with no single store choke point.
 */
function sliceForDiag(value: string): string {
  const clean = neutralizeControlChars(value);
  return clean.length > DIAG_NAME_MAX_CHARS ? `${clean.slice(0, DIAG_NAME_MAX_CHARS)}…` : clean;
}

/**
 * The slice of {@link McpRuntime} the proxies consume. Structural so unit tests
 * can drive the builder without spawning stdio servers; every production caller
 * passes the real runtime.
 */
export type McpToolSource = Pick<McpRuntime, "tools" | "callTool">;

export interface McpSchemaNormalization {
  /** The schema to expose to Pi (the original object when nothing changed). */
  schema: TSchema;
  /** Present when the schema was adjusted or replaced; wording is user-facing. */
  diagnostic?: string;
}

/**
 * `additionalProperties: true` fallback: accepts anything object-shaped, so a
 * degraded schema costs model-side guidance but never callability — argument
 * validation is the server's job either way.
 */
function permissiveObjectSchema(): TSchema {
  return {
    type: "object",
    properties: {},
    additionalProperties: true,
  } as unknown as TSchema;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Iterative deep scan for a `$ref` key (iterative on purpose: a hostile
 * deeply-nested schema must not overflow the stack). Deliberately over-matches
 * a property literally NAMED "$ref" (e.g. under `properties`): the false
 * positive only degrades that tool to the permissive schema — safe direction.
 */
function containsRef(root: unknown): boolean {
  const stack: unknown[] = [root];
  while (stack.length > 0) {
    const node = stack.pop();
    if (Array.isArray(node)) {
      stack.push(...node);
      continue;
    }
    if (typeof node !== "object" || node === null) continue;
    for (const [key, value] of Object.entries(node)) {
      if (key === "$ref") return true;
      stack.push(value);
    }
  }
  return false;
}

/** Bounded, neutralized probe-error text for a diagnostic. */
function probeErrText(err: unknown): string {
  const raw =
    typeof err === "object" && err !== null && typeof (err as { message?: unknown }).message === "string"
      ? (err as { message: string }).message
      : String(err);
  return sliceForDiag(raw);
}

/**
 * Normalize a server-supplied `inputSchema` into something Pi can serialize and
 * TypeBox can validate. The wire path is the verified soft spot: Pi serializes
 * `parameters` verbatim but pre-validates arguments with TypeBox `Compile` —
 * a schema Compile cannot handle makes EVERY call to that tool fail. So:
 *
 * - a schema-less tool gets the permissive object schema silently;
 * - `$schema` is stripped and a type/combinator-less root gets `type: "object"`;
 * - a non-object root, any `$ref` (an UNRESOLVABLE `$ref` compiles under the
 *   pinned typebox but then rejects every value — a throw-probe alone would
 *   miss it), an oversized/unserializable schema, or a Compile failure all
 *   degrade to the permissive schema with a diagnostic.
 *
 * An untouched schema is returned by reference (byte-identical on the wire).
 */
export function normalizeMcpSchema(raw: unknown, toolLabel: string): McpSchemaNormalization {
  if (raw === undefined || raw === null) {
    // Legal MCP: a tool may omit its schema. Not a degrade, no diagnostic.
    return { schema: permissiveObjectSchema() };
  }
  const fallback = (reason: string): McpSchemaNormalization => ({
    schema: permissiveObjectSchema(),
    diagnostic: `MCP tool "${sliceForDiag(toolLabel)}": input schema replaced with a permissive object schema (${reason}); the server still validates arguments`,
  });
  if (!isPlainObject(raw)) {
    return fallback("schema is not an object");
  }
  // Size/serializability first: the later scans assume a bounded document.
  let serialized: string;
  try {
    serialized = JSON.stringify(raw) ?? "";
  } catch {
    return fallback("schema is not JSON-serializable");
  }
  if (serialized.length > SCHEMA_MAX_CHARS) {
    return fallback(
      `schema is ${serialized.length} chars serialized, over the ${SCHEMA_MAX_CHARS}-char cap that bounds per-request schema cost`,
    );
  }
  if (containsRef(raw)) {
    return fallback("schema uses $ref, which the argument validator cannot reliably resolve");
  }
  const hasCombinator = ["anyOf", "oneOf", "allOf"].some((key) => raw[key] !== undefined);
  let schema: Record<string, unknown> = raw;
  if (raw.type === undefined) {
    if (!hasCombinator) {
      schema = { ...raw, type: "object" };
      delete schema["$schema"];
    } else if (raw["$schema"] !== undefined) {
      schema = { ...raw };
      delete schema["$schema"];
    }
  } else if (raw.type === "object") {
    if (raw["$schema"] !== undefined) {
      schema = { ...raw };
      delete schema["$schema"];
    }
  } else {
    // Tool arguments arrive as an object; a non-object root cannot be "wrapped"
    // without changing the argument shape the server expects.
    // sliceForDiag: `type` is server-supplied and could be an arbitrarily long
    // string — quoted unbounded it would ride the whole stderr line.
    return fallback(`schema root type is ${sliceForDiag(JSON.stringify(raw.type))}, not "object"`);
  }
  try {
    // Same pinned typebox Pi validates with: a schema that compiles here
    // compiles there. Compile-throw (e.g. an invalid regex pattern) would
    // otherwise fail every call to this tool at validation time.
    Compile(schema as never);
  } catch (err) {
    return fallback(`schema failed the TypeBox compile probe: ${probeErrText(err)}`);
  }
  return { schema: schema as unknown as TSchema };
}

/**
 * Text join of an MCP call result's content blocks. Text blocks pass verbatim;
 * embedded TEXT resources and resource links become labeled lines (Claude
 * delivers both — parity); everything else (images, audio, binary resource
 * blobs) degrades to one bounded omission note. `structuredContent` is ignored.
 */
function mapCallResult(result: unknown, serverName: string): { text: string; isError: boolean } {
  const record = isPlainObject(result) ? result : {};
  const parts: string[] = [];
  let omitted = 0;
  if (Array.isArray(record.content)) {
    for (const block of record.content) {
      if (!isPlainObject(block)) {
        omitted += 1;
        continue;
      }
      if (block.type === "text" && typeof block.text === "string") {
        parts.push(block.text);
        continue;
      }
      // Embedded resource whose payload is TEXT; blob resources stay omitted.
      // The resource text passes verbatim like a text block (the clip backstop
      // bounds size); the metadata is neutralized like every quoted value.
      if (block.type === "resource" && isPlainObject(block.resource) && typeof block.resource.text === "string") {
        const uri =
          typeof block.resource.uri === "string" ? neutralizeControlChars(block.resource.uri) : "unknown URI";
        parts.push(`[Resource from ${serverName} at ${uri}] ${block.resource.text}`);
        continue;
      }
      if (block.type === "resource_link") {
        const name = typeof block.name === "string" ? neutralizeControlChars(block.name) : "unnamed";
        const uri = typeof block.uri === "string" ? neutralizeControlChars(block.uri) : "";
        const description =
          typeof block.description === "string" && block.description !== ""
            ? ` (${neutralizeControlChars(block.description)})`
            : "";
        parts.push(`[Resource link: ${name}] ${uri}${description}`);
        continue;
      }
      omitted += 1;
    }
  }
  if (omitted > 0) {
    parts.push(
      `[PiCC: ${omitted} non-text MCP content block(s) omitted — image/audio/binary content is not yet supported]`,
    );
  }
  return { text: parts.join("\n"), isError: record.isError === true };
}

/** Builder diagnostics surface once per distinct message per process (the builder runs per dispatch). */
const reportedBuilderDiagnostics = new Set<string>();

function reportBuilderDiagnostic(message: string): void {
  if (reportedBuilderDiagnostics.has(message)) return;
  reportedBuilderDiagnostics.add(message);
  console.error(`PiCC MCP: ${message}`);
}

/**
 * Build one proxy `ToolDefinition` per connected-server tool. Fresh instances
 * per call; the runtime's metadata is already Claude-sanitized (names) and
 * bounded/neutralized (descriptions). Errors from `callTool` — timeouts
 * included — propagate as throws, which Pi turns into error tool results.
 */
export function buildMcpProxyTools(runtime: McpToolSource): ToolDefinition[] {
  const out: ToolDefinition[] = [];
  for (const info of runtime.tools()) {
    const { serverName, toolName } = info;
    const name = `mcp__${serverName}__${toolName}`;
    if (name.length > WIRE_NAME_MAX_CHARS) {
      // The runtime keeps long names (Claude parity — sanitized, not dropped);
      // the WIRE cannot: registering one would 400 every subsequent request.
      reportBuilderDiagnostic(
        `MCP tool "${sliceForDiag(name)}" dropped: its registered name is ${name.length} chars, ` +
          `over the ${WIRE_NAME_MAX_CHARS}-char model tool-name limit`,
      );
      continue;
    }
    const normalized = normalizeMcpSchema(info.inputSchema, name);
    if (normalized.diagnostic) reportBuilderDiagnostic(normalized.diagnostic);
    const definition: ToolDefinition = {
      name,
      label: name,
      description: info.description,
      parameters: normalized.schema,
      async execute(_toolCallId, params) {
        const result = await runtime.callTool(serverName, toolName, params ?? {});
        const mapped = mapCallResult(result, serverName);
        if (mapped.isError) {
          // MCP-protocol tool errors become Pi error tool results via throw.
          throw new Error(
            mapped.text || `MCP tool "${toolName}" on server "${serverName}" reported an error`,
          );
        }
        return {
          content: [{ type: "text", text: mapped.text }],
          details: { server: serverName, tool: toolName },
        };
      },
    };
    out.push(definition);
  }
  return out;
}

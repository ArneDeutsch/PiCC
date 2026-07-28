import { Compile } from "typebox/compile";
import type { TSchema } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { neutralizeControlChars } from "../util/neutralize-text.js";
import { semanticDisplayRow } from "./tool-display.js";
import { sanitizeDisplayText, themedFg } from "./render-util.js";
import { piToolsExpandKeyText } from "./pi-tui-runtime.js";
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
const FAIL_OPEN_TEXT_MAX_CHARS = 4_096;
const FAIL_OPEN_LINE_MAX = 16;

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

interface DisplayComponent {
  render(width: number): string[];
  invalidate(): void;
}

interface RetainedMcpSuccess {
  readonly owner: object;
  readonly source: string;
  sanitized?: string;
  readonly wrapped: Map<number, string[]>;
}

interface McpDisplayLifecycle {
  success?: RetainedMcpSuccess;
  reveal: boolean;
  cue?: string;
  theme?: unknown;
  call?: DisplayComponent;
}

const EMPTY_COMPONENT: DisplayComponent = Object.freeze({ render: () => [], invalidate() {} });

function objectKey(value: unknown): object | undefined {
  return ((typeof value === "object" && value !== null) || typeof value === "function")
    ? value as object
    : undefined;
}

function ownValue(value: unknown, key: PropertyKey): { found: boolean; value?: unknown } {
  const object = objectKey(value);
  if (!object) return { found: false };
  try {
    const descriptor = Object.getOwnPropertyDescriptor(object, key);
    return descriptor && "value" in descriptor
      ? { found: true, value: descriptor.value }
      : { found: false };
  } catch {
    return { found: false };
  }
}

function isArray(value: unknown): value is unknown[] {
  try { return Array.isArray(value); } catch { return false; }
}

function exactOwnKeys(value: unknown, expected: readonly string[]): boolean {
  const object = objectKey(value);
  if (!object) return false;
  try {
    if (Object.getPrototypeOf(object) !== Object.prototype) return false;
    const keys = Reflect.ownKeys(object);
    return keys.length === expected.length && keys.every((key) =>
      typeof key === "string" && expected.includes(key) && ownValue(object, key).found);
  } catch {
    return false;
  }
}

function exactMcpSuccess(
  result: unknown,
  options: unknown,
  context: unknown,
  serverName: string,
  toolName: string,
): { owner: object; source: string } | undefined {
  if (ownValue(options, "isPartial").value !== false || ownValue(context, "isPartial").value !== false ||
    ownValue(context, "isError").value !== false) return undefined;
  const resultError = ownValue(result, "isError");
  if (resultError.found && resultError.value !== false) return undefined;

  const details = ownValue(result, "details");
  if (!details.found || !exactOwnKeys(details.value, ["server", "tool"]) ||
    ownValue(details.value, "server").value !== serverName || ownValue(details.value, "tool").value !== toolName) {
    return undefined;
  }
  const content = ownValue(result, "content");
  if (!content.found || !isArray(content.value)) return undefined;
  try {
    if (Object.getPrototypeOf(content.value) !== Array.prototype || content.value.length !== 1 ||
      Reflect.ownKeys(content.value).length !== 2) return undefined;
  } catch {
    return undefined;
  }
  const blockEntry = ownValue(content.value, "0");
  const owner = objectKey(blockEntry.value);
  if (!blockEntry.found || !owner || !exactOwnKeys(owner, ["type", "text"]) ||
    ownValue(owner, "type").value !== "text") return undefined;
  const text = ownValue(owner, "text");
  return text.found && typeof text.value === "string" ? { owner, source: text.value } : undefined;
}

// MCP server text is hostile: C1/OSC controls can retitle the terminal or spoof surrounding rows.
// Sanitize only the human display copy here; canonical/model-visible MCP text remains verbatim.
function sanitizeCompleteMcpText(source: string): string {
  let text = source;
  try { text = text.normalize("NFC"); } catch { /* Keep the complete original string. */ }
  return text
    .replace(/(?:\u001b\]|\u009d)[\s\S]*?(?:\u0007|\u001b\\|\u009c|$)/gu, "�")
    .replace(/(?:\u001b\[|\u009b)[0-?]*[ -/]*[@-~]?/gu, "�")
    .replace(/\u001b(?:[ -/]*[@-~]?|.)?/gu, "�")
    .replace(/\r\n/gu, "\n")
    .replace(/\r/gu, "�")
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, (character) =>
      character === "\n" ? "\n" : character === "\t" ? "   " : "�");
}

function clampDisplayLine(line: string, width: number): string {
  if (!Number.isFinite(width) || width <= 0) return "";
  const columns = Math.floor(width);
  try { return visibleWidth(line) > columns ? truncateToWidth(line, columns, "…") : line; }
  catch { return ""; }
}

function retainedDetail(success: RetainedMcpSuccess, theme: unknown, width: number): string[] {
  if (!Number.isFinite(width) || width <= 0) return [""];
  const columns = Math.max(1, Math.floor(width));
  const cached = success.wrapped.get(columns);
  if (cached) return cached;
  success.sanitized ??= sanitizeCompleteMcpText(success.source);
  const lines: string[] = [];
  try {
    for (const sourceLine of success.sanitized.split("\n")) {
      const styled = themedFg(theme, "toolOutput", sourceLine);
      const wrapped = wrapTextWithAnsi(styled, columns);
      if (wrapped.length === 0) lines.push("");
      else for (const line of wrapped) lines.push(clampDisplayLine(line, columns));
    }
  } catch {
    lines.push(clampDisplayLine("MCP result renderer failed", columns));
  }
  success.wrapped.set(columns, lines);
  return lines;
}

function boundedFailOpenEvidence(result: unknown): string {
  const content = ownValue(result, "content");
  if (!content.found || !isArray(content.value)) return "Unfamiliar MCP result";
  const parts: string[] = [];
  let remaining = FAIL_OPEN_TEXT_MAX_CHARS;
  let length = 0;
  try { length = Math.min(content.value.length, FAIL_OPEN_LINE_MAX); } catch { return "Unfamiliar MCP result"; }
  for (let index = 0; index < length && remaining > 0; index++) {
    const block = ownValue(content.value, String(index));
    const type = ownValue(block.value, "type");
    const text = ownValue(block.value, "text");
    if (type.value === "text" && text.found && typeof text.value === "string") {
      const safe = sanitizeDisplayText(text.value, remaining);
      if (safe) {
        parts.push(safe);
        remaining -= safe.length;
      }
    } else {
      const note = "[MCP result contains non-text content]";
      parts.push(note);
      remaining -= note.length;
    }
  }
  return parts.length > 0 ? parts.join("\n") : "Unfamiliar MCP result";
}

function evidenceComponent(result: unknown, theme: unknown): DisplayComponent {
  const evidence = boundedFailOpenEvidence(result);
  return { invalidate() {}, render(width: number): string[] {
    if (!Number.isFinite(width) || width <= 0) return [""];
    const columns = Math.max(1, Math.floor(width));
    const lines: string[] = [];
    try {
      for (const sourceLine of evidence.split("\n").slice(0, FAIL_OPEN_LINE_MAX)) {
        const wrapped = wrapTextWithAnsi(themedFg(theme, "toolOutput", sourceLine), columns);
        if (wrapped.length === 0) lines.push("");
        else for (const line of wrapped) {
          if (lines.length >= FAIL_OPEN_LINE_MAX) break;
          lines.push(clampDisplayLine(line, columns));
        }
      }
    } catch {
      return [clampDisplayLine("Unfamiliar MCP result", columns)];
    }
    return lines.length > 0 ? lines : [clampDisplayLine("Unfamiliar MCP result", columns)];
  } };
}

function mcpOverview(serverName: string, toolName: string, theme: unknown, cue?: string): DisplayComponent {
  const row = semanticDisplayRow({
    action: "mcp",
    primary: toolName,
    required: [{ text: `server ${serverName}`, tone: "muted" }],
    ...(cue ? { cue, compactCue: cue.endsWith(" to expand") ? cue.slice(0, -" to expand".length) : cue } : {}),
  }, theme);
  return { render: (width) => row.render(width), invalidate() {} };
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
    const lifecycles = new WeakMap<object, McpDisplayLifecycle>();
    const htmlCallStates = new WeakSet<object>();
    const lifecycleFor = (context: unknown): { key: object; lifecycle: McpDisplayLifecycle } | undefined => {
      const state = objectKey(ownValue(context, "state").value) ?? objectKey(context);
      if (!state) return undefined;
      let lifecycle = lifecycles.get(state);
      if (!lifecycle) {
        lifecycle = { reveal: false };
        lifecycles.set(state, lifecycle);
      }
      return { key: state, lifecycle };
    };
    const definition: ToolDefinition = {
      name,
      label: `${toolName} (${serverName} MCP)`,
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
      renderCall(_args, theme, context) {
        const row = lifecycleFor(context);
        const htmlStatic = ownValue(context, "isPartial").value === true;
        if (row) {
          row.lifecycle.theme = theme;
          if (htmlStatic) htmlCallStates.add(row.key);
          else htmlCallStates.delete(row.key);
          row.lifecycle.call ??= { invalidate() {}, render(width: number): string[] {
            const lifecycle = row.lifecycle;
            const overview = mcpOverview(serverName, toolName, lifecycle.theme, lifecycle.cue);
            const lines = overview.render(width);
            if (lifecycle.success && lifecycle.reveal && lifecycle.success.source.length > 0) {
              return [...lines, ...retainedDetail(lifecycle.success, lifecycle.theme, width)];
            }
            return lines;
          } };
          if (!htmlStatic) return row.lifecycle.call;
        }
        return mcpOverview(serverName, toolName, theme);
      },
      renderResult(result, options, theme, context) {
        const row = lifecycleFor(context);
        const success = exactMcpSuccess(result, options, context, serverName, toolName);
        const html = row !== undefined && htmlCallStates.has(row.key);
        if (!success) {
          if (row) {
            row.lifecycle.success = undefined;
            row.lifecycle.reveal = false;
            row.lifecycle.cue = undefined;
          }
          return evidenceComponent(result, theme);
        }

        const retained = row?.lifecycle.success;
        const snapshot = retained?.owner === success.owner && retained.source === success.source
          ? retained
          : { owner: success.owner, source: success.source, wrapped: new Map<number, string[]>() };
        const requestedExpanded = ownValue(options, "expanded").value === true;
        if (html) {
          if (success.source.length === 0) return EMPTY_COMPONENT;
          return requestedExpanded
            ? { render: (width: number) => retainedDetail(snapshot, theme, width), invalidate() {} }
            : { render: (width: number) => [clampDisplayLine(themedFg(theme, "muted", "click to show detail"), width)], invalidate() {} };
        }

        const expansion = piToolsExpandKeyText();
        const binding = expansion.available
          ? sanitizeDisplayText(expansion.value, 512, true)
          : "";
        const reveal = requestedExpanded || !expansion.available || binding.length === 0;
        if (!row) {
          if (success.source.length === 0) return mcpOverview(serverName, toolName, theme);
          return reveal
            ? { render: (width: number) => [
                ...mcpOverview(serverName, toolName, theme).render(width),
                ...retainedDetail(snapshot, theme, width),
              ], invalidate() {} }
            : mcpOverview(serverName, toolName, theme, `${binding} to expand`);
        }
        row.lifecycle.success = snapshot;
        row.lifecycle.reveal = reveal;
        row.lifecycle.cue = success.source.length > 0 && !reveal ? `${binding} to expand` : undefined;
        row.lifecycle.theme = theme;
        return EMPTY_COMPONENT;
      },
    };
    out.push(definition);
  }
  return out;
}

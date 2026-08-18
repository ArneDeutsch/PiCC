import { createHash, randomUUID } from "node:crypto";
import { constants, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveClaudeProfile } from "./discovery/claude-profile.js";
import { createMcpAdministrationService, type McpAdministrationAction, type McpAdministrationResult, type McpAdministrationService } from "./mcp-administration/service.js";
import type { McpAdministrationInventory, McpAdministrationInventoryItem, McpAdministrationLiveState, McpMutationScope } from "./mcp-administration/model.js";
import { inspectMcpPendingOperation, persistMcpMutation, recoverMcpPendingOperation, type McpPersistenceContext } from "./mcp-administration/persistence.js";
import { createMcpLifecycleLocations } from "./plugin-lifecycle/locations.js";
import { establishOwnedStateStore, type OwnedStateStore, type StoreResult } from "./plugin-lifecycle/state-store.js";
import { loadClaudeProject, type LoadedProject } from "./project.js";
import { McpRuntime, type McpServerState } from "./runtime/mcp.js";
import { projectIdentities } from "./util/project-identity.js";

const MAX_JSON_INPUT = 1024 * 1024;
const MAX_NAME_CHARS = 128;
const CONTROL_CHAR = /[\u0000-\u001f\u007f-\u009f]/u;
const HELP = `Usage: picc mcp <command>

Commands:
  list [--scope|-s local|project|user]
  get <name> [--scope|-s local|project|user]
  add [--dry-run] [--scope|-s ...] [--transport|-t stdio] <name> [--env|-e KEY=VALUE ...] -- <command> [args...]
  add [--dry-run] [--scope|-s ...] --transport|-t http|sse <name> <url> [--header|-H "Name: Value" ...]
  add-json [--dry-run] [--scope|-s ...] <name> <json>
  add-json [--dry-run] [--scope|-s ...] <name> --json-file <path|->
  remove [--dry-run] [--scope|-s ...] <name>
  reset-project-choices [--dry-run]
  help [command]

List/get report a bounded acquired inventory; omitted declarations are counted. Eligible winners may be transiently started/contacted for bounded health and capability probing, then bounded shutdown is attempted. Scoped reads are a PiCC extension.
Use picc mcp <command> --help for command grammar.
Mutations run directly without confirmation. --dry-run evaluates the current safe snapshot without recovery or writes and may refuse where direct execution first recovers.
Inline JSON and --env/--header values may expose credentials in argv and shell history; for credential-bearing definitions prefer add-json --json-file <path|->.`;
const COMMAND_HELP: Readonly<Record<string, string>> = Object.freeze({
  list: "Usage: picc mcp list [--scope|-s local|project|user]\nReports a bounded acquired inventory and the effective winner; any omissions are counted. Eligible winners may be transiently started/contacted for bounded health and capability probing, then bounded shutdown is attempted. Scoped reads are a PiCC extension.",
  get: "Usage: picc mcp get <name> [--scope|-s local|project|user]\nReports the bounded acquired effective winner and same-name collisions; any omissions are counted. Eligible winners may be transiently started/contacted for bounded health and capability probing, then bounded shutdown is attempted. Scoped reads are a PiCC extension.",
  add: "Usage: picc mcp add [--dry-run] [--scope|-s local|project|user] [--transport|-t stdio] <name> [--env|-e KEY=VALUE ...] -- <command> [args...]\n       picc mcp add [--dry-run] [--scope|-s local|project|user] --transport|-t http|sse <name> <url> [--header|-H \"Name: Value\" ...]\nDefault scope: local. Static headers are supported; OAuth login is unavailable. --env/--header values may be exposed in argv and shell history; for credentials prefer add-json --json-file <path|->.",
  "add-json": "Usage: picc mcp add-json [--dry-run] [--scope|-s local|project|user] <name> <json>\n       picc mcp add-json [--dry-run] [--scope|-s local|project|user] <name> --json-file <path|->\nDefault scope: local. Inline JSON may expose credentials in argv and shell history; for credential-bearing definitions prefer add-json --json-file <path|->.",
  remove: "Usage: picc mcp remove [--dry-run] [--scope|-s local|project|user] <name>\nWithout --scope, removes the sole mutable same-name declaration and refuses ambiguity.",
  "reset-project-choices": "Usage: picc mcp reset-project-choices [--dry-run]\nResets PiCC-owned review choices across the active profile and checkout family; declarations and runtime-disable choices are preserved.",
});
const SYNTAX = "PiCC MCP: invalid arguments. Run `picc mcp --help` for usage.";
const TRANSIENT_PROBE_WARNING = "PiCC MCP: eligible winners may be transiently started or contacted for bounded health/capability probing, then bounded shutdown is attempted.";

export interface McpAdministrationCliOutput { log(message: string): void; error(message: string): void }
export interface McpHealthProjection { readonly state: "connected" | "auth-needed" | "failed"; readonly tools: number; readonly prompts: number; readonly resources: number }
export interface McpCliServiceHandle { readonly service: McpAdministrationService; health(name: string): McpHealthProjection | undefined }
interface TransientMcpRuntime {
  whenSettled(): Promise<unknown>;
  serverStates(): readonly McpServerState[];
  shutdown(): Promise<unknown>;
}

export interface McpAdministrationCliOptions {
  readonly cwd?: string; readonly env?: NodeJS.ProcessEnv; readonly homeDir?: string;
  readonly services?: (health: boolean) => Promise<StoreResult<McpCliServiceHandle>> | StoreResult<McpCliServiceHandle>;
  readonly readJsonInput?: (source: string) => Promise<StoreResult<unknown>>;
  readonly loadProject?: typeof loadClaudeProject;
  readonly startRuntime?: (config: LoadedProject["mcp"], options: { projectRoot: string; sessionId: string; env: NodeJS.ProcessEnv }) => TransientMcpRuntime;
}

type Operation =
  | { kind: "help"; command?: string }
  | { kind: "list"; scope?: McpMutationScope }
  | { kind: "get"; name: string; scope?: McpMutationScope }
  | { kind: "remove"; name: string; scope?: McpMutationScope; dryRun: boolean }
  | { kind: "mutation"; action: McpAdministrationAction; dryRun: boolean };

function syntax(): { ok: false; code: 2 } { return { ok: false, code: 2 }; }
function scopeValue(value: string | undefined): McpMutationScope | undefined { return value === "local" || value === "project" || value === "user" ? value : undefined; }
function validName(value: string | undefined): value is string { return value !== undefined && value.length > 0 && value.length <= MAX_NAME_CHARS && !CONTROL_CHAR.test(value); }
function takeValue(argv: readonly string[], index: number): string | undefined { const value = argv[index + 1]; return value !== undefined && value !== "--" ? value : undefined; }

function parseRead(kind: "list" | "get", argv: readonly string[]): Operation | undefined {
  let scope: McpMutationScope | undefined; const operands: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]!;
    if (token === "--scope" || token === "-s") { const value = scopeValue(takeValue(argv, i)); if (value === undefined || scope !== undefined) return undefined; scope = value; i += 1; }
    else if (token.startsWith("-")) return undefined; else operands.push(token);
  }
  if (kind === "list") return operands.length === 0 ? { kind, ...(scope === undefined ? {} : { scope }) } : undefined;
  return operands.length === 1 && validName(operands[0]) ? { kind, name: operands[0], ...(scope === undefined ? {} : { scope }) } : undefined;
}

function parseSimpleMutation(kind: "remove" | "reset-project-choices", argv: readonly string[]): Operation | undefined {
  let scope: McpMutationScope | undefined; let dryRun = false; const operands: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]!;
    if (token === "--dry-run") { if (dryRun) return undefined; dryRun = true; }
    else if (token === "--scope" || token === "-s") { if (kind === "reset-project-choices") return undefined; const value = scopeValue(takeValue(argv, i)); if (value === undefined || scope !== undefined) return undefined; scope = value; i += 1; }
    else if (token.startsWith("-")) return undefined; else operands.push(token);
  }
  if (kind === "reset-project-choices") return operands.length === 0 ? { kind: "mutation", action: { kind }, dryRun } : undefined;
  return operands.length === 1 && validName(operands[0]) ? { kind: "remove", name: operands[0], ...(scope === undefined ? {} : { scope }), dryRun } : undefined;
}

const ADD_OPTIONS = new Set(["--scope", "-s", "--transport", "-t", "--env", "-e", "--header", "-H", "--dry-run"]);

function parseAdd(argv: readonly string[]): Operation | undefined {
  const boundary = argv.indexOf("--");
  let scope: McpMutationScope | undefined; let transport: "stdio" | "http" | "sse" = "stdio"; let dryRun = false;
  const env: Record<string, string> = Object.create(null) as Record<string, string>; const headers: Record<string, string> = Object.create(null) as Record<string, string>; const operands: string[] = [];
  const before = boundary === -1 ? argv : argv.slice(0, boundary);
  for (let i = 0; i < before.length; i += 1) {
    const token = before[i]!;
    if (token === "--scope" || token === "-s") { const value = scopeValue(takeValue(before, i)); if (value === undefined || scope !== undefined) return undefined; scope = value; i += 1; }
    else if (token === "--transport" || token === "-t") { const value = takeValue(before, i); if (value !== "stdio" && value !== "http" && value !== "sse") return undefined; transport = value; i += 1; }
    else if (token === "--env" || token === "-e") {
      let consumed = 0;
      while (i + 1 < before.length && !ADD_OPTIONS.has(before[i + 1]!)) {
        const match = /^([^=\s]+)=(.*)$/su.exec(before[i + 1]!); if (match === null || Object.hasOwn(env, match[1]!)) return undefined;
        env[match[1]!] = match[2]!; i += 1; consumed += 1;
      }
      if (consumed === 0) return undefined;
    }
    else if (token === "--header" || token === "-H") {
      let consumed = 0;
      while (i + 1 < before.length && !ADD_OPTIONS.has(before[i + 1]!)) {
        const match = /^([^:\r\n]+):[ \t]*(.*)$/su.exec(before[i + 1]!); if (match === null || Object.hasOwn(headers, match[1]!)) return undefined;
        headers[match[1]!] = match[2]!; i += 1; consumed += 1;
      }
      if (consumed === 0) return undefined;
    }
    else if (token === "--dry-run") { if (dryRun) return undefined; dryRun = true; }
    else if (token.startsWith("-")) return undefined; else operands.push(token);
  }
  let name: string | undefined; let definition: Record<string, unknown>;
  if (transport === "stdio") {
    if (boundary === -1 || operands.length !== 1 || !validName(operands[0]) || argv.length <= boundary + 1 || Object.keys(headers).length > 0) return undefined;
    name = operands[0]; definition = { command: argv[boundary + 1]!, args: argv.slice(boundary + 2), ...(Object.keys(env).length === 0 ? {} : { env }) };
  } else {
    if (boundary !== -1 || operands.length !== 2 || !validName(operands[0]) || Object.keys(env).length > 0) return undefined;
    name = operands[0]; definition = { type: transport, url: operands[1]!, ...(Object.keys(headers).length === 0 ? {} : { headers }) };
  }
  return { kind: "mutation", action: { kind: "add", scope: scope ?? "local", name, definition }, dryRun };
}

function parseAddJson(argv: readonly string[]): { operation: Omit<Extract<Operation, { kind: "mutation" }>, "action"> & { name: string; scope: McpMutationScope; inline?: string; file?: string } } | undefined {
  let scope: McpMutationScope | undefined; let dryRun = false; let file: string | undefined; const operands: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]!;
    if (token === "--scope" || token === "-s") { const value = scopeValue(takeValue(argv, i)); if (value === undefined || scope !== undefined) return undefined; scope = value; i += 1; }
    else if (token === "--json-file") { const value = takeValue(argv, i); if (value === undefined || file !== undefined) return undefined; file = value; i += 1; }
    else if (token === "--dry-run") { if (dryRun) return undefined; dryRun = true; }
    else if (token.startsWith("-")) return undefined; else operands.push(token);
  }
  if (!validName(operands[0])) return undefined;
  if (file === undefined && operands.length === 2) return { operation: { kind: "mutation", name: operands[0], scope: scope ?? "local", inline: operands[1], dryRun } };
  if (file !== undefined && operands.length === 1) return { operation: { kind: "mutation", name: operands[0], scope: scope ?? "local", file, dryRun } };
  return undefined;
}

export function parseMcpAdministrationArgv(argv: readonly string[]): Operation | { ok: false; code: 2 } | { addJson: NonNullable<ReturnType<typeof parseAddJson>>["operation"] } {
  if (argv.length === 1 && (argv[0] === "--help" || argv[0] === "-h")) return { kind: "help" };
  const [command, ...rest] = argv;
  const commands = new Set(["list", "get", "add", "add-json", "remove", "reset-project-choices"]);
  if (command === "help") return rest.length === 0 ? { kind: "help" } : commands.has(rest[0]!) ? { kind: "help", command: rest[0] } : syntax();
  if (commands.has(command ?? "") && rest.some((token) => token === "--help" || token === "-h")) return { kind: "help", command };
  if (command === "list" || command === "get") return parseRead(command, rest) ?? syntax();
  if (command === "remove" || command === "reset-project-choices") return parseSimpleMutation(command, rest) ?? syntax();
  if (command === "add") return parseAdd(rest) ?? syntax();
  if (command === "add-json") { const parsed = parseAddJson(rest); return parsed === undefined ? syntax() : { addJson: parsed.operation }; }
  return syntax();
}

async function boundedStream(input: NodeJS.ReadableStream): Promise<StoreResult<unknown>> {
  const chunks: Buffer[] = []; let size = 0;
  try { for await (const chunk of input) { const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)); size += bytes.length; if (size > MAX_JSON_INPUT) return { ok: false, code: "input-too-large", message: "input too large" }; chunks.push(bytes); } return decodeJson(Buffer.concat(chunks)); }
  catch { return { ok: false, code: "input-read-failed", message: "input read failed" }; }
}
function decodeJson(bytes: Buffer): StoreResult<unknown> {
  try { const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); return { ok: true, value: JSON.parse(text) as unknown }; }
  catch { return { ok: false, code: "invalid-json-input", message: "invalid JSON input" }; }
}
export async function readMcpJsonInput(source: string, stdin: NodeJS.ReadableStream = process.stdin, afterOpen?: () => void | Promise<void>): Promise<StoreResult<unknown>> {
  if (source === "-") return boundedStream(stdin);
  try {
    const namedBefore = await fs.lstat(source, { bigint: true });
    if (!namedBefore.isFile() || namedBefore.isSymbolicLink() || namedBefore.size > BigInt(MAX_JSON_INPUT)) return { ok: false, code: "invalid-json-input", message: "invalid JSON input" };
    const handle = await fs.open(source, constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      const opened = await handle.stat({ bigint: true });
      if (!opened.isFile() || opened.dev !== namedBefore.dev || opened.ino !== namedBefore.ino || opened.size > BigInt(MAX_JSON_INPUT)) return { ok: false, code: "invalid-json-input", message: "invalid JSON input" };
      await afterOpen?.(); const chunks: Buffer[] = []; let position = 0;
      while (true) {
        const chunk = Buffer.alloc(Math.min(64 * 1024, MAX_JSON_INPUT + 1 - position));
        const { bytesRead } = await handle.read(chunk, 0, chunk.length, position);
        if (bytesRead === 0) break;
        position += bytesRead;
        if (position > MAX_JSON_INPUT) return { ok: false, code: "input-too-large", message: "input too large" };
        chunks.push(chunk.subarray(0, bytesRead));
      }
      const openedAfter = await handle.stat({ bigint: true }); const namedAfter = await fs.lstat(source, { bigint: true });
      const unchanged = position === Number(opened.size) && openedAfter.dev === opened.dev && openedAfter.ino === opened.ino && openedAfter.size === opened.size && openedAfter.mtimeNs === opened.mtimeNs && openedAfter.ctimeNs === opened.ctimeNs && namedAfter.dev === opened.dev && namedAfter.ino === opened.ino && namedAfter.isFile() && !namedAfter.isSymbolicLink();
      return unchanged ? decodeJson(Buffer.concat(chunks, position)) : { ok: false, code: "input-read-failed", message: "input read failed" };
    } finally { await handle.close(); }
  } catch { return { ok: false, code: "input-read-failed", message: "input read failed" }; }
}
function objectDefinition(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function safe(value: unknown, maximum = 160): string { return String(value).replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ").slice(0, maximum); }
function renderedName(name: string): string { return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(name) && !name.includes("__") ? name : JSON.stringify(name.slice(0, MAX_NAME_CHARS)); }
function selectedRows(inventory: McpAdministrationInventory, name?: string, scope?: McpMutationScope): readonly McpAdministrationInventoryItem[] {
  return inventory.servers.filter((row) => (name === undefined || row.name === name) && (scope === undefined || row.authority.kind === "mutable" && row.authority.scope === scope));
}
function probeEligible(row: McpAdministrationInventoryItem): boolean { return row.precedence === "winner" && row.status === "enabled" && row.policy === "allowed" && row.review !== "pending" && row.review !== "rejected-exact" && row.review !== "rejected-compatibility"; }
function healthText(row: McpAdministrationInventoryItem, projected: McpHealthProjection | undefined): string {
  if (row.review === "pending") return "pending-review";
  if (row.review === "rejected-exact" || row.review === "rejected-compatibility") return "rejected";
  if (row.precedence !== "winner" || row.status !== "enabled") return "not-probed";
  return projected?.state ?? (row.live === "connected" ? "connected" : row.live === "failed" ? "failed" : "not-probed");
}
function renderInventory(inventory: McpAdministrationInventory, rows: readonly McpAdministrationInventoryItem[], handle: McpCliServiceHandle, scoped = false): string {
  const lines = [`MCP inventory${scoped ? " (PiCC scoped-read extension)" : ""}: policy=${inventory.policyPosture}; declarations=${rows.length}; omitted=${inventory.omittedDeclarationCount}`];
  if (inventory.remediation !== undefined) lines.push("Recovery: reads cannot recover pending MCP administration state; open `/mcp manage` in an interactive TUI to attempt service-owned recovery, then retry this read.");
  for (const row of rows) {
    const projected = probeEligible(row) ? handle.health(row.name) : undefined; const authority = row.authority.kind === "mutable" ? row.authority.scope : `read-only:${row.authority.sourceClass}`;
    lines.push(`${renderedName(row.name)}: scope=${authority}; precedence=${row.precedence}; source=${row.source}; policy=${row.policy}; review=${row.review}; status=${row.status}; health=${healthText(row, projected)}; transport=${row.summary.transport ?? "unsupported"}; capabilities=${projected?.tools ?? row.capabilityCounts.tools}/${projected?.prompts ?? row.capabilityCounts.prompts}/${projected?.resources ?? row.capabilityCounts.resources}`);
  }
  if (rows.length === 0) lines.push("No matching MCP servers.");
  if (rows.some((row) => row.review === "pending" || row.review === "rejected-exact" || row.review === "rejected-compatibility")) lines.push("Review guidance: use interactive `/mcp manage`, or explicit trusted user/managed compatibility settings.");
  const authRows = rows.filter((row) => probeEligible(row) && handle.health(row.name)?.state === "auth-needed");
  if (authRows.some((row) => row.summary.headerKeyCount > 0)) lines.push("Authentication guidance: verify configured static headers; OAuth login is unavailable and deferred.");
  if (authRows.some((row) => row.summary.headerKeyCount === 0)) lines.push("Authentication guidance: OAuth login is unavailable and deferred; configure supported static headers where applicable.");
  return lines.join("\n");
}
function resultPlan(action: McpAdministrationAction, result: { inventory: McpAdministrationInventory; eligibility: { eligible: boolean; reasonCode: string } }, dryRun: boolean): string {
  const target = action.kind === "reset-project-choices" ? "project-family review choices" : `${"scope" in action ? `${action.scope} ` : ""}${"name" in action ? renderedName(action.name) : ""}`.trim();
  return [`MCP ${dryRun ? "dry-run" : "result"}: action=${action.kind}; target=${target}`, `Eligibility: ${result.eligibility.eligible ? "eligible" : `refused:${result.eligibility.reasonCode}`}`, ...(dryRun ? ["Writes: none (dry-run)"] : [])].join("\n");
}
function operationalSuccess(result: McpAdministrationResult): boolean { return result.eligibility.eligible && result.recovery.state !== "pending-recovery" && result.durable.state !== "pending-recovery" && result.runtime.state !== "failed" && result.exposure.state !== "failed"; }
function renderRecovery(result: McpAdministrationResult["recovery"]): string {
  if (result.state === "not-requested") return "";
  return `Recovery: state=${result.state}; effect=${result.effect}; cleanup=${result.cleanup}${result.reasonCode === undefined ? "" : `; reason=${result.reasonCode}`}`;
}
function remediation(reasonCode: string, dryRun = false): string | undefined {
  return ({
    "recovery-pending": dryRun
      ? "Action: dry-run cannot recover pending MCP administration state; open `/mcp manage` in an interactive TUI to attempt service-owned recovery, then retry the original dry-run."
      : "Action: retry this administration command to continue safe rollback; no new writes are allowed until recovery completes.",
    "invalid-authority": "Action: rerun from the intended project and selected Claude profile after any project/profile change.",
    "stale-state": "Action: reacquire current MCP state and retry the command.",
    busy: "Action: wait for the competing MCP administration operation to finish, then retry.",
    "cleanup-pending": "Action: retry administration cleanup before making another MCP change.",
    "already-exists": "Action: choose a different server name or remove the exact-scope declaration before adding it again.",
    "server-not-found": "Action: list the bounded acquired inventory and retry with an exact visible server name.",
    "scope-mismatch": "Action: list the server's mutable scopes and retry with the matching --scope value.",
  } as Readonly<Record<string, string>>)[reasonCode];
}
function renderAddedState(action: Extract<McpAdministrationAction, { kind: "add" }>, inventory: McpAdministrationInventory): string {
  const row = inventory.servers.find((item) => item.name === action.name && item.authority.kind === "mutable" && item.authority.scope === action.scope && item.agentOwner === undefined);
  if (row === undefined) return "Declaration state: committed/not-visible; live activation=not-requested; health=not-probed";
  const lines = [`Declaration state: name=${renderedName(row.name)}; scope=${action.scope}; precedence=${row.precedence}; review=${row.review}; status=${row.status}; health=not-probed`];
  if (row.review === "pending" || row.review === "rejected-exact" || row.review === "rejected-compatibility") lines.push("Review guidance: use interactive `/mcp manage`, or explicit trusted user/managed compatibility settings.");
  return lines.join("\n");
}

export async function runMcpAdministrationCli(argv: readonly string[], output: McpAdministrationCliOutput = console, options: McpAdministrationCliOptions = {}): Promise<number> {
  let parsed = parseMcpAdministrationArgv(argv);
  if ("ok" in parsed) { output.error(SYNTAX); return 2; }
  if ("kind" in parsed && parsed.kind === "help") { output.log(parsed.command === undefined ? HELP : COMMAND_HELP[parsed.command]!); return 0; }
  if ("addJson" in parsed) {
    const inlineBytes = parsed.addJson.inline === undefined ? undefined : Buffer.from(parsed.addJson.inline, "utf8");
    const source = inlineBytes !== undefined && inlineBytes.byteLength > MAX_JSON_INPUT ? { ok: false as const, code: "input-too-large", message: "input too large" } : parsed.addJson.inline === undefined ? await (options.readJsonInput ?? readMcpJsonInput)(parsed.addJson.file!) : decodeJson(inlineBytes!);
    if (!source.ok || !objectDefinition(source.value)) { output.error("PiCC MCP: JSON input is invalid, unreadable, or exceeds the 1 MiB UTF-8 limit."); return 2; }
    parsed = { kind: "mutation", action: { kind: "add", scope: parsed.addJson.scope, name: parsed.addJson.name, definition: source.value }, dryRun: parsed.addJson.dryRun };
  }
  const health = parsed.kind === "list" || parsed.kind === "get";
  if (health) output.error(TRANSIENT_PROBE_WARNING);
  let composed: StoreResult<McpCliServiceHandle>;
  try { composed = await (options.services ?? ((enabled) => createProductionMcpCliServices({ ...options, health: enabled })))(health); }
  catch { output.error("PiCC MCP: administration unavailable (composition-failed)."); return 1; }
  if (!composed.ok) { output.error(`PiCC MCP: administration unavailable (${safe(composed.code, 80)}).`); return 1; }
  const handle = composed.value;
  let preparedRecovery: McpAdministrationResult["recovery"] | undefined;
  try {
    if (parsed.kind === "list" || parsed.kind === "get") {
      const inventory = await handle.service.inventory(); const rows = selectedRows(inventory, parsed.kind === "get" ? parsed.name : undefined, parsed.scope);
      output.log(renderInventory(inventory, rows, handle, parsed.scope !== undefined));
      return parsed.kind === "get" && rows.length === 0 ? 1 : 0;
    }
    if (parsed.kind === "remove") {
      const removeName = parsed.name; const removeDryRun = parsed.dryRun; let scope = parsed.scope;
      if (scope === undefined) {
        const resolution = removeDryRun
          ? await handle.service.inventory().then((current) => ({ inventory: current, eligibility: current.remediation === undefined ? { eligible: true as const, reasonCode: "eligible" as const } : { eligible: false as const, reasonCode: "recovery-pending" as const } }))
          : await handle.service.prepareInventoryAfterRecovery();
        preparedRecovery = "recovery" in resolution ? resolution.recovery as McpAdministrationResult["recovery"] : undefined;
        if (preparedRecovery !== undefined && preparedRecovery.state !== "not-requested") output.log(renderRecovery(preparedRecovery));
        if (!resolution.eligibility.eligible) {
          const guidance = remediation(resolution.eligibility.reasonCode, removeDryRun); if (guidance !== undefined) output.log(guidance); return 1;
        }
        const matches = resolution.inventory.servers.filter((row) => row.name === removeName && row.authority.kind === "mutable" && row.agentOwner === undefined);
        if (matches.length === 0) { output.error("PiCC MCP: no mutable server with that exact name was found."); output.log(remediation("server-not-found")!); return 1; }
        if (matches.length !== 1) { output.error("PiCC MCP: that name is declared in multiple mutable scopes; pass --scope."); output.log(remediation("scope-mismatch")!); return 1; }
        scope = (matches[0]!.authority as { kind: "mutable"; scope: McpMutationScope }).scope;
      }
      parsed = { kind: "mutation", action: { kind: "remove", scope, name: removeName }, dryRun: removeDryRun };
    }
    if (parsed.dryRun) {
      const preview = await handle.service.preview(parsed.action);
      output.log(resultPlan(parsed.action, preview, true)); const guidance = remediation(preview.eligibility.reasonCode, true); if (guidance !== undefined) output.log(guidance); return preview.eligibility.eligible ? 0 : 1;
    }
    const result = await handle.service.execute(parsed.action);
    if (parsed.action.kind === "add" && result.eligibility.eligible && result.durable.state === "committed" && result.durable.cleanup === "complete") { output.log(renderAddedState(parsed.action, result.inventory)); return 0; }
    output.log(resultPlan(parsed.action, result, false));
    const guidance = remediation(result.eligibility.reasonCode) ?? (result.durable.state === "not-requested" ? undefined : remediation(result.durable.reasonCode ?? "")); if (guidance !== undefined) output.log(guidance);
    if (result.recovery.state !== "not-requested") output.log(renderRecovery(result.recovery));
    if (result.durable.state !== "not-requested") output.log(`Durable: state=${result.durable.state}; effect=${result.durable.effect}; cleanup=${result.durable.cleanup}${result.durable.reasonCode === undefined ? "" : `; reason=${result.durable.reasonCode}`}`);
    return operationalSuccess(result) ? 0 : 1;
  } catch { output.error("PiCC MCP: administration failed without exposing input details."); return 1; }
}

function passiveStore(locations: ReturnType<typeof createMcpLifecycleLocations> & { ok: true }): OwnedStateStore {
  const root = locations.value.profileRoot; return { root, profileRoot: root, profileKey: locations.value.profileKey, artifactsRoot: path.join(root, "artifacts", "sha256"), recordsRoot: path.join(root, "records"), stagingRoot: path.join(root, "staging"), generationsRoot: path.join(root, "generations"), journalsRoot: path.join(root, "journals"), receiptsRoot: path.join(root, "receipts"), locksRoot: path.join(root, "locks"), quarantineRoot: path.join(root, "quarantine"), dataRoot: locations.value.dataRoot };
}
function liveState(state: McpServerState): McpAdministrationLiveState { return { name: state.name, state: state.state === "retrying" ? "connecting" : state.state, ...(state.toolCount === undefined ? {} : { toolCount: state.toolCount }), ...(state.promptCount === undefined ? {} : { promptCount: state.promptCount }), ...(state.resourceCount === undefined ? {} : { resourceCount: state.resourceCount }) }; }

export async function createProductionMcpCliServices(options: McpAdministrationCliOptions & { health: boolean }): Promise<StoreResult<McpCliServiceHandle>> {
  try {
    const cwd = path.resolve(options.cwd ?? process.cwd()); const home = path.resolve(options.homeDir ?? os.homedir()); const env = options.env ?? process.env; const loadProject = options.loadProject ?? loadClaudeProject;
    const profile = resolveClaudeProfile({ env, homeDir: home }); const initial = loadProject({ cwd, env, homeDir: home, pluginInventoryLifetime: "command" });
    const identities = projectIdentities(initial.root); const family = identities[0]; const active = identities.at(-1);
    if (family === undefined || active === undefined) return { ok: false, code: "project-unavailable", message: "project unavailable" };
    const locations = createMcpLifecycleLocations({ homeDir: home, profilePath: initial.userDir, platform: process.platform === "win32" ? "win32" : "posix", project: { activeCheckoutPath: active, checkoutFamilyPath: family } });
    if (!locations.ok || locations.value.checkoutFamilyKey === undefined) return { ok: false, code: "authority-unavailable", message: "authority unavailable" };
    const capturedProfilePath = path.resolve(initial.userDir); const capturedProjectRoot = path.resolve(initial.root); const capturedFamilyKey = locations.value.checkoutFamilyKey;
    const passive = passiveStore(locations); const authorityFingerprint = `sha256:${createHash("sha256").update(`${capturedProfilePath}\0${capturedProjectRoot}\0${capturedFamilyKey}`, "utf8").digest("hex")}`;
    const revalidateAuthority = (): StoreResult<{ profileKey: string; checkoutFamilyKey: string; authorityFingerprint: string }> => {
      try {
        const freshProfile = resolveClaudeProfile({ env, homeDir: home }); const freshProject = loadProject({ cwd, env, homeDir: home, pluginInventoryLifetime: "command" });
        const freshIdentities = projectIdentities(freshProject.root); const freshFamily = freshIdentities[0]; const freshActive = freshIdentities.at(-1);
        if (freshFamily === undefined || freshActive === undefined || path.resolve(freshProfile.userDir) !== capturedProfilePath || path.resolve(freshProject.userDir) !== capturedProfilePath || path.resolve(freshProject.root) !== capturedProjectRoot) return { ok: false, code: "changed-authority", message: "authority changed" };
        const freshLocations = createMcpLifecycleLocations({ homeDir: home, profilePath: freshProject.userDir, platform: process.platform === "win32" ? "win32" : "posix", project: { activeCheckoutPath: freshActive, checkoutFamilyPath: freshFamily } });
        if (!freshLocations.ok || freshLocations.value.profileKey !== passive.profileKey || freshLocations.value.checkoutFamilyKey !== capturedFamilyKey) return { ok: false, code: "changed-authority", message: "authority changed" };
        const freshFingerprint = `sha256:${createHash("sha256").update(`${path.resolve(freshProject.userDir)}\0${path.resolve(freshProject.root)}\0${freshLocations.value.checkoutFamilyKey}`, "utf8").digest("hex")}`;
        return freshFingerprint === authorityFingerprint ? { ok: true, value: { profileKey: passive.profileKey, checkoutFamilyKey: capturedFamilyKey, authorityFingerprint } } : { ok: false, code: "changed-authority", message: "authority changed" };
      } catch { return { ok: false, code: "changed-authority", message: "authority changed" }; }
    };
    let established: OwnedStateStore | undefined; const writableStore = async () => { if (established !== undefined) return established; const result = await establishOwnedStateStore(locations.value, home); if (!result.ok) throw new Error("store unavailable"); established = result.value; return established; };
    const context = async (): Promise<McpPersistenceContext> => ({ store: await writableStore(), profilePath: profile.nativeStatePath, projectRoot: capturedProjectRoot, checkoutFamilyKey: capturedFamilyKey, authorityFingerprint, revalidateAuthority });
    const inspectPending = async () => {
      try { await fs.lstat(passive.profileRoot); return inspectMcpPendingOperation(passive); }
      catch (error) { return (error as NodeJS.ErrnoException).code === "ENOENT" ? { pending: false as const, status: "clear" as const } : { pending: true as const, status: "invalid" as const }; }
    };
    const healthByName = new Map<string, McpHealthProjection>();
    const assemble = async () => {
      const project = loadProject({ cwd, env, homeDir: home, pluginInventoryLifetime: "command" }); let liveStates: readonly McpAdministrationLiveState[] | undefined;
      if (options.health) {
        healthByName.clear(); const runtime = (options.startRuntime ?? ((config, runtimeOptions) => McpRuntime.start(config, runtimeOptions)))(project.mcp, { projectRoot: project.root, sessionId: `picc-mcp-cli-${randomUUID()}`, env });
        try { await runtime.whenSettled(); const states = runtime.serverStates(); liveStates = states.map(liveState); for (const state of states) healthByName.set(state.name, { state: state.state === "connected" ? "connected" : state.statusSummary?.includes("authentication") ? "auth-needed" : "failed", tools: state.toolCount ?? 0, prompts: state.promptCount ?? 0, resources: state.resourceCount ?? 0 }); }
        finally { await runtime.shutdown(); }
      }
      return { mcp: project.mcp, reviewIdentity: { profileKey: project.mcpStartupAuthority.profileKey ?? passive.profileKey, checkoutFamilyKey: project.mcpStartupAuthority.checkoutFamilyKey ?? capturedFamilyKey }, ...(liveStates === undefined ? {} : { liveStates }) };
    };
    const service = createMcpAdministrationService({ inspectPending, recover: async () => recoverMcpPendingOperation(await context()), mutate: async (mutation) => persistMcpMutation(await context(), mutation), assemble });
    return { ok: true, value: { service, health: (name) => healthByName.get(name) } };
  } catch { return { ok: false, code: "administration-unavailable", message: "administration unavailable" }; }
}

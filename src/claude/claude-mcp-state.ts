import fs from "node:fs";
import path from "node:path";
import {
  canonicalDirectory,
  projectIdentities,
  type CanonicalDirectoryResult,
} from "../util/project-identity.js";
import { normalizeMcpServerBlock, type RawMcpEntry } from "./mcp-config.js";

/** Bounds applied while loading and normalizing native Claude MCP state. */
export const CLAUDE_MCP_STATE_LIMITS = Object.freeze({
  fileBytes: 1024 * 1024,
  projects: 256,
  projectKeyChars: 4096,
  serversPerScope: 256,
  serverNameChars: 128,
  listItems: 256,
  arrayItems: 256,
  containerDepth: 10,
  properties: 4096,
  propertyNameChars: 256,
  stringChars: 16 * 1024,
  materialChars: 256 * 1024,
  diagnostics: 32,
  diagnosticChars: 256,
});

export interface ClaudeMcpStateFileSystem {
  open(file: string): number;
  fstat(fd: number): fs.Stats;
  read(fd: number, buffer: Buffer, offset: number, length: number, position: number): number;
  close(fd: number): void;
}

export interface ClaudeMcpStateContribution {
  source: "native-user" | "native-local";
  /** Normalized but deliberately unexpanded server definitions. */
  servers: RawMcpEntry[];
}

export interface ClaudeMcpStateLoaded {
  kind: "loaded";
  user: ClaudeMcpStateContribution;
  local: ClaudeMcpStateContribution;
  disabledMcpServers: ReadonlySet<string>;
  /** Presence means Claude's default-off allow-list was recognized, not applied. */
  enabledMcpServers?: readonly string[];
  diagnostics: string[];
}

export interface ClaudeMcpStateAbsent {
  kind: "absent";
  diagnostics: [];
}

export interface ClaudeMcpStateUnusable {
  kind: "unusable";
  diagnostics: string[];
}

export type ClaudeMcpStateResult =
  | ClaudeMcpStateAbsent
  | ClaudeMcpStateLoaded
  | ClaudeMcpStateUnusable;

export interface LoadClaudeMcpStateOptions {
  statePath: string;
  projectRoot: string;
  fileSystem?: Partial<ClaudeMcpStateFileSystem>;
  canonicalizeProject?: (candidate: string) => CanonicalDirectoryResult;
  identifyProject?: (projectRoot: string) => readonly string[];
}

const nativeFileSystem: ClaudeMcpStateFileSystem = {
  open: (file) => fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK),
  fstat: (fd) => fs.fstatSync(fd),
  read: (fd, buffer, offset, length, position) => fs.readSync(fd, buffer, offset, length, position),
  close: (fd) => fs.closeSync(fd),
};

const SERVER_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unusable(message: string): ClaudeMcpStateUnusable {
  return {
    kind: "unusable",
    diagnostics: [message.slice(0, CLAUDE_MCP_STATE_LIMITS.diagnosticChars)],
  };
}

function readSnapshot(
  file: string,
  overrides?: Partial<ClaudeMcpStateFileSystem>,
): { kind: "absent" } | { kind: "unusable"; reason: string } | { kind: "bytes"; bytes: Buffer } {
  const io = { ...nativeFileSystem, ...overrides };
  let fd: number | undefined;
  let outcome: { kind: "absent" } | { kind: "unusable"; reason: string } | { kind: "bytes"; bytes: Buffer };
  try {
    fd = io.open(file);
    const stat = io.fstat(fd);
    if (!stat.isFile()) {
      outcome = { kind: "unusable", reason: "Native Claude state is not a regular file" };
    } else if (stat.size > CLAUDE_MCP_STATE_LIMITS.fileBytes) {
      outcome = { kind: "unusable", reason: "Native Claude state exceeds the file-size limit" };
    } else {
      const buffer = Buffer.allocUnsafe(CLAUDE_MCP_STATE_LIMITS.fileBytes + 1);
      let length = 0;
      while (length < buffer.length) {
        const count = io.read(fd, buffer, length, buffer.length - length, length);
        if (count === 0) break;
        if (!Number.isInteger(count) || count < 0 || count > buffer.length - length) {
          throw new Error("invalid injected read result");
        }
        length += count;
      }
      outcome = length > CLAUDE_MCP_STATE_LIMITS.fileBytes
        ? { kind: "unusable", reason: "Native Claude state grew beyond the file-size limit while reading" }
        : { kind: "bytes", bytes: buffer.subarray(0, length) };
    }
  } catch (error) {
    outcome = fd === undefined && (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT"
      ? { kind: "absent" }
      : { kind: "unusable", reason: "Native Claude state could not be read" };
  } finally {
    if (fd !== undefined) {
      try {
        io.close(fd);
      } catch {
        outcome = { kind: "unusable", reason: "Native Claude state could not be read" };
      }
    }
  }
  return outcome!;
}

function decodeJson(bytes: Buffer): { ok: true; value: unknown } | { ok: false; reason: string } {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return { ok: false, reason: "Native Claude state is not valid UTF-8" };
  }
  if (text.startsWith("\uFEFF")) text = text.slice(1);
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, reason: "Native Claude state is malformed JSON" };
  }
}

interface MaterialBudget {
  properties: number;
  chars: number;
}

function boundedMaterial(value: unknown, depth: number, budget: MaterialBudget): boolean {
  if (typeof value === "string") {
    budget.chars += value.length;
    return value.length <= CLAUDE_MCP_STATE_LIMITS.stringChars &&
      budget.chars <= CLAUDE_MCP_STATE_LIMITS.materialChars;
  }
  if (value === null || typeof value === "number" || typeof value === "boolean") return true;
  if (depth > CLAUDE_MCP_STATE_LIMITS.containerDepth) return false;
  if (Array.isArray(value)) {
    return value.length <= CLAUDE_MCP_STATE_LIMITS.arrayItems &&
      value.every((item) => boundedMaterial(item, depth + 1, budget));
  }
  if (!isRecord(value)) return false;
  const entries = Object.entries(value);
  budget.properties += entries.length;
  if (budget.properties > CLAUDE_MCP_STATE_LIMITS.properties) return false;
  for (const [key, item] of entries) {
    budget.chars += key.length;
    if (
      key.length > CLAUDE_MCP_STATE_LIMITS.propertyNameChars ||
      budget.chars > CLAUDE_MCP_STATE_LIMITS.materialChars ||
      !boundedMaterial(item, depth + 1, budget)
    ) return false;
  }
  return true;
}

function validServerName(value: string): boolean {
  return value.length <= CLAUDE_MCP_STATE_LIMITS.serverNameChars &&
    SERVER_NAME_RE.test(value) && !value.includes("__");
}

function runtimeList(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value) || value.length > CLAUDE_MCP_STATE_LIMITS.listItems) return undefined;
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string" || !validServerName(item)) return undefined;
    seen.add(item);
  }
  return [...seen];
}

function structurallyEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) &&
      left.length === right.length && left.every((item, index) => structurallyEqual(item, right[index]));
  }
  if (!isRecord(left) || !isRecord(right)) return false;
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return leftKeys.length === rightKeys.length && leftKeys.every((key, index) =>
    key === rightKeys[index] && Object.hasOwn(right, key) && structurallyEqual(left[key], right[key]));
}

type BlockPreflight =
  | { ok: true; block: Record<string, unknown> }
  | { ok: false; reason: "shape" | "structural" };

function preflightBlock(value: unknown): BlockPreflight {
  if (!isRecord(value)) return { ok: false, reason: "shape" };
  if (
    Object.keys(value).length > CLAUDE_MCP_STATE_LIMITS.serversPerScope ||
    !boundedMaterial(value, 0, { properties: 0, chars: 0 })
  ) return { ok: false, reason: "structural" };
  return { ok: true, block: value };
}

interface LocalMcpProjection {
  block: Record<string, unknown>;
  disabled: readonly string[];
  enabled?: readonly string[];
}

type LocalProjectionResult =
  | { ok: true; projection: LocalMcpProjection }
  | { ok: false; diagnostic: string };

function localMcpProjection(record: unknown): LocalProjectionResult {
  if (!isRecord(record)) {
    return { ok: false, diagnostic: "Matching native Claude project record has an invalid shape" };
  }
  const localPreflight = preflightBlock(
    Object.hasOwn(record, "mcpServers") ? record.mcpServers : Object.create(null),
  );
  if (!localPreflight.ok) {
    return {
      ok: false,
      diagnostic: localPreflight.reason === "shape"
        ? "Native Claude local MCP state has an invalid object shape"
        : "Native Claude local MCP state exceeds structural limits",
    };
  }

  let disabled: readonly string[] = [];
  if (Object.hasOwn(record, "disabledMcpServers")) {
    const parsed = runtimeList(record.disabledMcpServers);
    if (parsed === undefined) {
      return { ok: false, diagnostic: "Native Claude disabled MCP list has an invalid shape" };
    }
    disabled = parsed;
  }

  let enabled: readonly string[] | undefined;
  if (Object.hasOwn(record, "enabledMcpServers")) {
    enabled = runtimeList(record.enabledMcpServers);
    if (enabled === undefined) {
      return { ok: false, diagnostic: "Native Claude enabled MCP list has an invalid shape" };
    }
  }
  return {
    ok: true,
    projection: {
      block: localPreflight.block,
      disabled,
      ...(enabled === undefined ? {} : { enabled }),
    },
  };
}

function sameNameSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const rightNames = new Set(right);
  return left.every((name) => rightNames.has(name));
}

function equivalentLocalMcp(left: LocalMcpProjection, right: LocalMcpProjection): boolean {
  return structurallyEqual(left.block, right.block) &&
    sameNameSet(left.disabled, right.disabled) &&
    (left.enabled === undefined) === (right.enabled === undefined) &&
    (left.enabled === undefined || right.enabled === undefined || sameNameSet(left.enabled, right.enabled));
}

function safeNormalize(
  block: Record<string, unknown>,
  source: ClaudeMcpStateContribution["source"],
  diagnostics: string[],
): RawMcpEntry[] {
  const normalized = normalizeMcpServerBlock(block, source === "native-user" ? "native Claude user state" : "native Claude local state");
  for (const entry of normalized) {
    if (entry.diagnostics.length === 0) continue;
    const canName = validServerName(entry.name);
    const scope = source === "native-user" ? "user" : "local";
    const finding = entry.skipped
      ? canName
        ? `Native ${scope} MCP server "${entry.name}" has an invalid or unsupported definition and was skipped`
        : `Native ${scope} MCP state contains an invalid server definition that was skipped`
      : canName
        ? `Native ${scope} MCP server "${entry.name}" has configuration PiCC ignored or adjusted; its definition was retained for later resolution`
        : `Native ${scope} MCP state contains adjusted server configuration; the definition was retained for later resolution`;
    entry.diagnostics = [];
    if (diagnostics.length < CLAUDE_MCP_STATE_LIMITS.diagnostics) diagnostics.push(finding);
  }
  return normalized;
}

function isEligibleLocalPath(value: string): boolean {
  if (value.length === 0 || value.includes("\0")) return false;
  if (/^(?:\\\\|\/\/|\\[?.]\\)/.test(value)) return false;
  if (process.platform === "win32") return /^[A-Za-z]:[\\/]/.test(value);
  return value.startsWith("/") && !value.startsWith("//") && path.posix.isAbsolute(value);
}

/** Load one inert, read-only snapshot of Claude's native MCP state. Never throws. */
export function loadClaudeMcpState(options: LoadClaudeMcpStateOptions): ClaudeMcpStateResult {
  const snapshot = readSnapshot(options.statePath, options.fileSystem);
  if (snapshot.kind === "absent") return { kind: "absent", diagnostics: [] };
  if (snapshot.kind === "unusable") return unusable(snapshot.reason);

  const decoded = decodeJson(snapshot.bytes);
  if (!decoded.ok) return unusable(decoded.reason);
  if (!isRecord(decoded.value)) return unusable("Native Claude state root is not an object");
  const root = decoded.value;
  const nonProjectRoot = Object.create(null) as Record<string, unknown>;
  for (const [key, value] of Object.entries(root)) {
    if (key !== "projects") nonProjectRoot[key] = value;
  }
  if (!boundedMaterial(nonProjectRoot, 0, { properties: 0, chars: 0 })) {
    return unusable("Native Claude user state exceeds structural limits");
  }

  let identities: readonly string[];
  try {
    identities = (options.identifyProject ?? projectIdentities)(options.projectRoot);
  } catch {
    identities = [];
  }
  const familyIdentity = identities[0];
  if (familyIdentity === undefined) return unusable("Active project identity could not be established");
  if (!isEligibleLocalPath(familyIdentity)) {
    return unusable("Active project identity uses an unsupported path class");
  }

  const userPreflight = preflightBlock(
    Object.hasOwn(root, "mcpServers") ? root.mcpServers : Object.create(null),
  );
  if (!userPreflight.ok) {
    return unusable(userPreflight.reason === "shape"
      ? "Native Claude user MCP state has an invalid object shape"
      : "Native Claude user MCP state exceeds structural limits");
  }
  const userBlock = userPreflight.block;

  const matchingRecords: unknown[] = [];
  if (Object.hasOwn(root, "projects")) {
    if (!isRecord(root.projects)) return unusable("Native Claude project state has an invalid shape");
    const records = Object.entries(root.projects);
    if (records.length > CLAUDE_MCP_STATE_LIMITS.projects) {
      return unusable("Native Claude project state exceeds the project-count limit");
    }
    if (records.some(([key]) => key.length > CLAUDE_MCP_STATE_LIMITS.projectKeyChars)) {
      return unusable("Native Claude project state contains an oversized project key");
    }
    const projectRecordBudget: MaterialBudget = { properties: 0, chars: 0 };
    for (const [, record] of records) {
      if (!boundedMaterial(record, 0, projectRecordBudget)) {
        return unusable("Native Claude project records exceed structural limits");
      }
    }
    const canonicalize = options.canonicalizeProject ?? ((candidate: string) => canonicalDirectory(candidate));
    for (const [candidate, record] of records) {
      if (!isEligibleLocalPath(candidate)) continue;
      let canonical: CanonicalDirectoryResult;
      try {
        canonical = canonicalize(candidate);
      } catch {
        canonical = { kind: "indeterminate" };
      }
      if (canonical.kind === "indeterminate") {
        return unusable("Native Claude project identity could not be determined safely");
      }
      if (canonical.kind === "canonical" && canonical.path === familyIdentity) matchingRecords.push(record);
    }
  }

  let selected: LocalMcpProjection | undefined;
  for (const record of matchingRecords) {
    const projected = localMcpProjection(record);
    if (!projected.ok) return unusable(projected.diagnostic);
    if (selected === undefined) {
      selected = projected.projection;
    } else if (!equivalentLocalMcp(selected, projected.projection)) {
      return unusable("Native Claude project MCP state has conflicting matching records");
    }
  }
  selected ??= { block: Object.create(null), disabled: [] };

  const diagnostics: string[] = [];
  if (selected.enabled !== undefined) {
    diagnostics.push("Native Claude enabledMcpServers is unsupported; listed default-off servers remain disabled");
  }
  const user = safeNormalize(userBlock, "native-user", diagnostics);
  const local = safeNormalize(selected.block, "native-local", diagnostics);
  return {
    kind: "loaded",
    user: { source: "native-user", servers: user },
    local: { source: "native-local", servers: local },
    disabledMcpServers: new Set(selected.disabled),
    ...(selected.enabled === undefined ? {} : { enabledMcpServers: selected.enabled }),
    diagnostics: diagnostics.slice(0, CLAUDE_MCP_STATE_LIMITS.diagnostics),
  };
}

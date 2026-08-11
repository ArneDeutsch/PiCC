import fs from "node:fs";
import path from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { PostCommitStage } from "./mid-run-compaction.js";
import type { RetainedInputReport } from "./retained-input-report.js";

const MAX_OCCURRENCES = 256;
const MAX_SERIALIZED_BYTES = 512 * 1024;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,95}$/u;
const MAX_SESSION_ID_CHARS = 256;
const SESSION_ID_CONTROL = /[\u0000-\u001f\u007f]/u;
const CUSTOM_TYPE = "picc-retained-input-report";
const STAGES = new Set<PostCommitStage>([
  "restoration", "continuation-start", "input-replay", "provider-release",
  "resumed-work", "resumed-cancellation", "cancellation-join",
]);

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
interface PersistedOccurrence { id: number; mode: "steer" | "followUp"; content: JsonValue }

export interface RetainedInputPersistenceRecord {
  version: 1;
  report: {
    agentId: string;
    sessionId: string;
    generation: number;
    stage: PostCommitStage;
    occurrences: PersistedOccurrence[];
  };
}

export type RetainedInputPersistenceLocator =
  | { kind: "session-entry"; sessionFile: string; entryId: string }
  | { kind: "recovery-file"; sessionFile: string; path: string };

export interface RetainedInputPersistenceSession {
  getSessionFile(): string | undefined;
  getSessionDir?(): string | undefined;
  getCwd?(): string | undefined;
  getBranch?(): unknown;
  appendCustomEntry?(customType: string, data?: unknown): unknown;
}

export interface RetainedInputPersistenceOptions {
  session: RetainedInputPersistenceSession;
  /** Test-only bounded I/O replacement. Production uses the pinned Pi SessionManager. */
  reopenSession?: (file: string, sessionDir: string, cwd: string) => RetainedInputPersistenceSession;
}

export type RetainedInputPersistenceFailure = "report-incomplete" | "storage-unsafe";

export class RetainedInputPersistenceError extends Error {
  readonly category: RetainedInputPersistenceFailure;
  constructor(category: RetainedInputPersistenceFailure = "storage-unsafe") {
    super(category === "report-incomplete"
      ? "Retained input is incomplete or cannot be represented by the durable report; no durable locator was established."
      : "Retained input could not be durably persisted; no durable locator was established.");
    this.name = "RetainedInputPersistenceError";
    this.category = category;
  }
}

function fail(category: RetainedInputPersistenceFailure = "storage-unsafe"): never {
  throw new RetainedInputPersistenceError(category);
}

function normalizeJson(value: unknown, depth = 0, seen = new Set<object>()): JsonValue {
  if (depth > 20) fail("report-incomplete");
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) fail("report-incomplete");
    return value;
  }
  if (typeof value !== "object" || seen.has(value)) fail("report-incomplete");
  const prototype = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) fail("report-incomplete");
  if (Object.getOwnPropertySymbols(value).length > 0) fail("report-incomplete");
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      const descriptors = Object.getOwnPropertyDescriptors(value);
      const output: JsonValue[] = [];
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = descriptors[String(index)];
        if (!descriptor || !("value" in descriptor)) fail("report-incomplete");
        output.push(normalizeJson(descriptor.value, depth + 1, seen));
      }
      return output;
    }
    const output: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>;
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
      if (!descriptor.enumerable) continue;
      if (!("value" in descriptor)) fail("report-incomplete");
      output[key] = normalizeJson(descriptor.value, depth + 1, seen);
    }
    return output;
  } finally {
    seen.delete(value);
  }
}

function validChildSessionId(sessionId: string, agentId: string): boolean {
  if (sessionId.length === 0 || sessionId.length > MAX_SESSION_ID_CHARS || SESSION_ID_CONTROL.test(sessionId)) return false;
  const separator = sessionId.indexOf(":");
  if (separator <= 0 || separator !== sessionId.lastIndexOf(":")) return false;
  const parentId = sessionId.slice(0, separator);
  return parentId.trim() === parentId && sessionId.slice(separator + 1) === agentId;
}

function safeRecord(report: RetainedInputReport): { record: RetainedInputPersistenceRecord; bytes: Buffer } {
  if (!SAFE_ID.test(report.agentId) || !validChildSessionId(report.sessionId, report.agentId) ||
      !Number.isSafeInteger(report.generation) || report.generation < 0 || !STAGES.has(report.stage) ||
      report.unrepresentableCount !== 0 || report.occurrences.length > MAX_OCCURRENCES) {
    fail(report.unrepresentableCount !== 0 || !STAGES.has(report.stage) ? "report-incomplete" : "storage-unsafe");
  }
  const ids = new Set<number>();
  const occurrences: PersistedOccurrence[] = report.occurrences.map(({ shadow }) => {
    if (!Number.isSafeInteger(shadow.id) || shadow.id < 0 || ids.has(shadow.id) ||
        shadow.sessionId !== report.sessionId || shadow.generation !== report.generation ||
        (shadow.delivery !== "steer" && shadow.delivery !== "followUp")) fail("report-incomplete");
    ids.add(shadow.id);
    return { id: shadow.id, mode: shadow.delivery, content: normalizeJson(shadow.content) };
  });
  const record: RetainedInputPersistenceRecord = {
    version: 1,
    report: { agentId: report.agentId, sessionId: report.sessionId, generation: report.generation, stage: report.stage, occurrences },
  };
  let bytes: Buffer;
  try { bytes = Buffer.from(JSON.stringify(record), "utf8"); } catch { fail("report-incomplete"); }
  if (bytes.length === 0 || bytes.length > MAX_SERIALIZED_BYTES) fail("report-incomplete");
  return { record, bytes };
}

type Identity = { dev: bigint; ino: bigint };
type Owner = { path: string; identity: Identity; sessionIdentity: Identity };

function sameIdentity(left: Identity, right: Identity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function regularIdentity(file: string, restrictive = false): Identity {
  const stat = fs.lstatSync(file, { bigint: true });
  if (!stat.isFile() || stat.isSymbolicLink()) fail();
  if (restrictive && process.platform !== "win32" && (stat.mode & 0o077n) !== 0n) fail();
  return { dev: stat.dev, ino: stat.ino };
}

function directoryIdentity(directory: string): Identity {
  const stat = fs.lstatSync(directory, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail();
  return { dev: stat.dev, ino: stat.ino };
}

function contained(owner: string, candidate: string): boolean {
  const relative = path.relative(owner, candidate);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function verifiedOwner(sessionFile: string, managerDir: string | undefined): Owner {
  const sessionAbsolute = path.resolve(sessionFile);
  const ownerInput = managerDir ? path.resolve(managerDir) : path.dirname(sessionAbsolute);
  const originalSession = fs.lstatSync(sessionAbsolute);
  if (!originalSession.isFile() || originalSession.isSymbolicLink()) fail();
  const identity = directoryIdentity(ownerInput);
  const owner = fs.realpathSync.native(ownerInput);
  const sessionReal = fs.realpathSync.native(sessionAbsolute);
  if (!contained(owner, sessionReal)) fail();
  return { path: owner, identity, sessionIdentity: regularIdentity(sessionAbsolute) };
}

function verifySessionOwner(sessionFile: string, owner: Owner, permissionSafe = false): void {
  const ownerReal = fs.realpathSync.native(path.dirname(path.resolve(sessionFile)));
  if (ownerReal !== owner.path || !sameIdentity(owner.identity, directoryIdentity(owner.path))) fail();
  const real = fs.realpathSync.native(sessionFile);
  if (!contained(owner.path, real) ||
      !sameIdentity(owner.sessionIdentity, regularIdentity(sessionFile, permissionSafe))) fail();
}

function dataProperty(record: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}

function findExactEntry(branch: unknown, entryId: string, expectedJson: string): boolean {
  if (!Array.isArray(branch)) return false;
  for (const candidate of branch) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
    if (dataProperty(candidate, "id") !== entryId) continue;
    if (dataProperty(candidate, "type") !== "custom" || dataProperty(candidate, "customType") !== CUSTOM_TYPE) return false;
    try { return JSON.stringify(normalizeJson(dataProperty(candidate, "data"))) === expectedJson; } catch { return false; }
  }
  return false;
}

function primary(session: RetainedInputPersistenceSession, sessionFile: string, owner: Owner,
  record: RetainedInputPersistenceRecord, expectedJson: string,
  reopen: NonNullable<RetainedInputPersistenceOptions["reopenSession"]>): RetainedInputPersistenceLocator {
  if (typeof session.appendCustomEntry !== "function" || typeof session.getBranch !== "function") fail();
  // Native Pi session files commonly follow the process umask. They remain valid
  // owner evidence, but only a restrictive inode may be claimed as the durable sink.
  verifySessionOwner(sessionFile, owner, true);
  const entryId = session.appendCustomEntry(CUSTOM_TYPE, record);
  if (typeof entryId !== "string" || entryId.length === 0 || entryId.length > 200) fail();
  verifySessionOwner(sessionFile, owner, true);
  if (!findExactEntry(session.getBranch(), entryId, expectedJson)) fail();
  const reopened = reopen(sessionFile, session.getSessionDir?.() ?? owner.path, session.getCwd?.() ?? process.cwd());
  if (!findExactEntry(reopened.getBranch?.(), entryId, expectedJson)) fail();
  verifySessionOwner(sessionFile, owner, true);
  return { kind: "session-entry", sessionFile, entryId };
}

function verifyRecoveryFile(destination: string, sessionFile: string, owner: Owner, bytes: Buffer, expectedJson: string): boolean {
  try {
    verifySessionOwner(sessionFile, owner);
    const identity = regularIdentity(destination, true);
    const real = fs.realpathSync.native(destination);
    if (!contained(owner.path, real)) return false;
    const reopened = fs.readFileSync(destination);
    if (!reopened.equals(bytes) || JSON.stringify(normalizeJson(JSON.parse(reopened.toString("utf8")))) !== expectedJson) return false;
    return sameIdentity(identity, regularIdentity(destination, true));
  } catch { return false; }
}

function fallback(report: RetainedInputReport, sessionFile: string, owner: Owner, bytes: Buffer, expectedJson: string): RetainedInputPersistenceLocator {
  const base = `.picc-retained-${report.agentId}-${report.generation}.json`;
  if (path.basename(base) !== base || base.includes("..") || path.isAbsolute(base)) fail();
  const destination = path.join(owner.path, base);
  if (fs.existsSync(destination)) {
    if (verifyRecoveryFile(destination, sessionFile, owner, bytes, expectedJson)) {
      return { kind: "recovery-file", sessionFile, path: destination };
    }
    fail();
  }
  const temporary = path.join(owner.path, `.${base}.${process.pid}.${Date.now().toString(36)}.tmp`);
  if (!contained(owner.path, destination) || !contained(owner.path, temporary)) fail();
  let handle: number | undefined;
  let published = false;
  try {
    handle = fs.openSync(temporary, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW, 0o600);
    fs.writeFileSync(handle, bytes);
    fs.fchmodSync(handle, 0o600);
    fs.fsyncSync(handle);
    const tempIdentity = regularIdentity(temporary, true);
    fs.closeSync(handle);
    handle = undefined;
    verifySessionOwner(sessionFile, owner);
    fs.linkSync(temporary, destination);
    published = true;
    if (process.platform !== "win32") {
      const directory = fs.openSync(owner.path, fs.constants.O_RDONLY);
      try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
    }
    if (!sameIdentity(tempIdentity, regularIdentity(destination, true))) fail();
    fs.unlinkSync(temporary);
    if (process.platform !== "win32") {
      const directory = fs.openSync(owner.path, fs.constants.O_RDONLY);
      try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
    }
    if (!verifyRecoveryFile(destination, sessionFile, owner, bytes, expectedJson)) fail();
    return { kind: "recovery-file", sessionFile, path: destination };
  } catch { fail(); } finally {
    if (handle !== undefined) try { fs.closeSync(handle); } catch { /* best effort */ }
    try { fs.unlinkSync(temporary); } catch { /* best effort */ }
    if (published) { /* Keep an exclusively published file when post-publication verification is ambiguous. */ }
  }
  return fail();
}

/** Persist one complete canonical report through one primary attempt and at most one atomic fallback. */
export function persistRetainedInputReport(report: RetainedInputReport, options: RetainedInputPersistenceOptions): RetainedInputPersistenceLocator {
  const { record, bytes } = safeRecord(report);
  const expectedJson = bytes.toString("utf8");
  const sessionFile = options.session.getSessionFile();
  if (!sessionFile) fail();
  let owner: Owner;
  try { owner = verifiedOwner(sessionFile, options.session.getSessionDir?.()); } catch (error) {
    if (error instanceof RetainedInputPersistenceError) throw error;
    fail();
  }
  const reopen = options.reopenSession ?? ((file, sessionDir, cwd) => SessionManager.open(file, sessionDir, cwd));
  try { return primary(options.session, sessionFile, owner, record, expectedJson, reopen); } catch {
    return fallback(report, sessionFile, owner, bytes, expectedJson);
  }
}

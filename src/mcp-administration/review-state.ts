import { createHash } from "node:crypto";
import fsSync, { constants, promises as fs, type BigIntStats } from "node:fs";
import path from "node:path";
import type { OwnedStateStore, StoreResult } from "../plugin-lifecycle/state-store.js";
import { MCP_REVIEW_LIMITS, validateAndCopyMcpReviewSnapshot } from "./review-definition.js";
import type { McpReviewRecord, McpReviewSnapshot } from "./model.js";

export const MCP_REVIEW_STATE_FILENAME = "mcp-review";
export const MCP_REVIEW_STATE_MAX_BYTES = 512 * 1024;

function fail(code: string, message: string): StoreResult<never> { return { ok: false, code, message }; }
function samePath(left: string, right: string): boolean { return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right; }

export function mcpReviewStatePath(store: OwnedStateStore, checkoutFamilyKey: string): StoreResult<string> {
  if (!/^checkout-[A-Za-z0-9_-]{1,256}$/.test(checkoutFamilyKey) || !/^profile-[A-Za-z0-9_-]{1,128}$/.test(store.profileKey)) {
    return fail("invalid-owner", "Review profile or checkout family identity is invalid");
  }
  const identity = createHash("sha256")
    .update(`picc\0mcp-review-state\0v1\0${store.profileKey}\0${checkoutFamilyKey}\0`, "utf8")
    .digest("base64url");
  return { ok: true, value: path.join(store.recordsRoot, `${MCP_REVIEW_STATE_FILENAME}-${identity}.json`) };
}

export interface McpReviewStateCapture {
  readonly snapshot: McpReviewSnapshot;
  readonly bytes?: Readonly<Uint8Array>;
}

function absentCapture(store: OwnedStateStore, checkoutFamilyKey: string): StoreResult<McpReviewStateCapture> {
  return { ok: true, value: Object.freeze({ snapshot: Object.freeze({
    version: 1, profileKey: store.profileKey, checkoutFamilyKey, records: Object.freeze([]),
  }) }) };
}

function validOpenedFile(target: string, opened: BigIntStats, named: BigIntStats, realPath: string): boolean {
  return opened.isFile() && opened.nlink === 1n && named.isFile() && !named.isSymbolicLink() && opened.dev === named.dev && opened.ino === named.ino &&
    opened.size <= BigInt(MCP_REVIEW_STATE_MAX_BYTES) && samePath(path.resolve(realPath), path.resolve(target));
}

function validateCapture(inputs: {
  readonly store: OwnedStateStore;
  readonly checkoutFamilyKey: string;
  readonly target: string;
  readonly opened: BigIntStats;
  readonly named: BigIntStats;
  readonly after: BigIntStats;
  readonly realPath: string;
  readonly bytes: Uint8Array;
}): StoreResult<McpReviewStateCapture> {
  const { opened, named, after, bytes } = inputs;
  if (!validOpenedFile(inputs.target, opened, named, inputs.realPath) || bytes.byteLength > MCP_REVIEW_STATE_MAX_BYTES || BigInt(bytes.byteLength) !== opened.size ||
    after.dev !== opened.dev || after.ino !== opened.ino || after.nlink !== 1n || after.size !== opened.size || !after.isFile() || after.isSymbolicLink()) {
    return fail("invalid-review-state", "Private MCP review state is unavailable or invalid");
  }
  try {
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const validated = validateAndCopyMcpReviewSnapshot(JSON.parse(decoded) as unknown);
    if (validated.invalid || validated.snapshot === undefined || validated.snapshot.profileKey !== inputs.store.profileKey || validated.snapshot.checkoutFamilyKey !== inputs.checkoutFamilyKey) {
      return fail("invalid-review-state", "Private MCP review state is unavailable or invalid");
    }
    return { ok: true, value: Object.freeze({ snapshot: validated.snapshot, bytes: Buffer.from(bytes) }) };
  } catch { return fail("invalid-review-state", "Private MCP review state is unavailable or invalid"); }
}

export async function readMcpReviewStateCapture(inputs: {
  readonly store: OwnedStateStore;
  readonly checkoutFamilyKey: string;
}): Promise<StoreResult<McpReviewStateCapture>> {
  const target = mcpReviewStatePath(inputs.store, inputs.checkoutFamilyKey); if (!target.ok) return target;
  try {
    const handle = await fs.open(target.value, constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      const opened = await handle.stat({ bigint: true }); const named = await fs.lstat(target.value, { bigint: true }); const realPath = await fs.realpath(target.value);
      if (!validOpenedFile(target.value, opened, named, realPath)) return fail("invalid-review-state", "Private MCP review state is unavailable or invalid");
      const bytes = await handle.readFile(); const after = await fs.lstat(target.value, { bigint: true });
      return validateCapture({ ...inputs, target: target.value, opened, named, after, realPath, bytes });
    } finally { await handle.close(); }
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? absentCapture(inputs.store, inputs.checkoutFamilyKey) : fail("invalid-review-state", "Private MCP review state is unavailable or invalid");
  }
}

/** Synchronous, read-only startup capture with the same validation as the persistence reader. */
export function readMcpReviewStateCaptureSync(inputs: {
  readonly store: OwnedStateStore;
  readonly checkoutFamilyKey: string;
}): StoreResult<McpReviewStateCapture> {
  const target = mcpReviewStatePath(inputs.store, inputs.checkoutFamilyKey); if (!target.ok) return target;
  try {
    const handle = fsSync.openSync(target.value, constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      const opened = fsSync.fstatSync(handle, { bigint: true }); const named = fsSync.lstatSync(target.value, { bigint: true }); const realPath = fsSync.realpathSync.native(target.value);
      if (!validOpenedFile(target.value, opened, named, realPath)) return fail("invalid-review-state", "Private MCP review state is unavailable or invalid");
      const bytes = fsSync.readFileSync(handle); const after = fsSync.lstatSync(target.value, { bigint: true });
      return validateCapture({ ...inputs, target: target.value, opened, named, after, realPath, bytes });
    } finally { fsSync.closeSync(handle); }
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? absentCapture(inputs.store, inputs.checkoutFamilyKey) : fail("invalid-review-state", "Private MCP review state is unavailable or invalid");
  }
}

export async function readMcpReviewState(inputs: { readonly store: OwnedStateStore; readonly checkoutFamilyKey: string }): Promise<StoreResult<McpReviewSnapshot>> {
  const captured = await readMcpReviewStateCapture(inputs);
  return captured.ok ? { ok: true, value: captured.value.snapshot } : captured;
}

function sameOwner(left: McpReviewRecord, right: McpReviewRecord): boolean {
  return left.profileKey === right.profileKey && left.checkoutFamilyKey === right.checkoutFamilyKey && left.source === right.source &&
    left.serverName === right.serverName && left.agentOwner?.name === right.agentOwner?.name && left.agentOwner?.scope === right.agentOwner?.scope;
}

export function setMcpReviewRecord(snapshot: McpReviewSnapshot, candidate: McpReviewRecord): StoreResult<McpReviewSnapshot> {
  const validated = validateAndCopyMcpReviewSnapshot({ version: 1, profileKey: snapshot.profileKey, checkoutFamilyKey: snapshot.checkoutFamilyKey, records: [candidate] });
  const record = validated.snapshot?.records[0];
  if (validated.invalid || record === undefined || record.profileKey !== snapshot.profileKey || record.checkoutFamilyKey !== snapshot.checkoutFamilyKey) return fail("invalid-review", "Review identity does not match the active profile and checkout family");
  const records = snapshot.records.filter((item) => !sameOwner(item, record)); records.push(record);
  if (records.length > MCP_REVIEW_LIMITS.records) return fail("review-limit", "Private MCP review record limit would be exceeded");
  return { ok: true, value: Object.freeze({ ...snapshot, records: Object.freeze(records) }) };
}

export function resetMcpReviewRecords(snapshot: McpReviewSnapshot): McpReviewSnapshot {
  return Object.freeze({ version: 1, profileKey: snapshot.profileKey, checkoutFamilyKey: snapshot.checkoutFamilyKey, records: Object.freeze([]) });
}

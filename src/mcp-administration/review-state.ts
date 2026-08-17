import { createHash } from "node:crypto";
import { constants, promises as fs } from "node:fs";
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
  const owner = createHash("sha256").update(`${MCP_REVIEW_STATE_FILENAME}\0${store.profileKey}`, "utf8").digest("base64url");
  const family = createHash("sha256").update(checkoutFamilyKey, "utf8").digest("base64url");
  return { ok: true, value: path.join(store.recordsRoot, `${MCP_REVIEW_STATE_FILENAME}-${owner}-${family}.json`) };
}

export interface McpReviewStateCapture {
  readonly snapshot: McpReviewSnapshot;
  readonly bytes?: Readonly<Uint8Array>;
}

export async function readMcpReviewStateCapture(inputs: {
  readonly store: OwnedStateStore;
  readonly checkoutFamilyKey: string;
}): Promise<StoreResult<McpReviewStateCapture>> {
  const target = mcpReviewStatePath(inputs.store, inputs.checkoutFamilyKey); if (!target.ok) return target;
  try {
    const handle = await fs.open(target.value, constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      const opened = await handle.stat({ bigint: true }); const named = await fs.lstat(target.value, { bigint: true });
      if (!opened.isFile() || opened.nlink !== 1n || !named.isFile() || named.isSymbolicLink() || opened.dev !== named.dev || opened.ino !== named.ino ||
        opened.size > BigInt(MCP_REVIEW_STATE_MAX_BYTES) || !samePath(path.resolve(await fs.realpath(target.value)), path.resolve(target.value))) throw new Error("unsafe");
      const bytes = await handle.readFile(); const after = await fs.lstat(target.value, { bigint: true });
      if (bytes.byteLength > MCP_REVIEW_STATE_MAX_BYTES || after.dev !== opened.dev || after.ino !== opened.ino || !after.isFile() || after.isSymbolicLink()) throw new Error("changed");
      const decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      const validated = validateAndCopyMcpReviewSnapshot(JSON.parse(decoded) as unknown);
      if (validated.invalid || validated.snapshot === undefined || validated.snapshot.profileKey !== inputs.store.profileKey || validated.snapshot.checkoutFamilyKey !== inputs.checkoutFamilyKey) throw new Error("invalid");
      return { ok: true, value: Object.freeze({ snapshot: validated.snapshot, bytes: Buffer.from(bytes) }) };
    } finally { await handle.close(); }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ok: true, value: Object.freeze({ snapshot: Object.freeze({
      version: 1, profileKey: inputs.store.profileKey, checkoutFamilyKey: inputs.checkoutFamilyKey, records: Object.freeze([]),
    }) }) };
    return fail("invalid-review-state", "Private MCP review state is unavailable or invalid");
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

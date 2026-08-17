import { randomBytes } from "node:crypto";
import { constants, promises as fs } from "node:fs";
import path from "node:path";
import { selectNativeProjectRecord } from "../claude/claude-mcp-state.js";
import { normalizeMcpServerBlock } from "../claude/mcp-config.js";
import { acquireLifecycleLocks, releaseLifecycleLocks, type LifecycleLockLease, type ProcessOwnershipProbe } from "../plugin-lifecycle/locks.js";
import { createMcpLifecycleLocations } from "../plugin-lifecycle/locations.js";
import { previewRecovery, recoverTransaction } from "../plugin-lifecycle/recovery.js";
import { sha256, type OwnedStateStore, type StoreResult } from "../plugin-lifecycle/state-store.js";
import {
  createTransactionCodecRegistry, executeTransaction, isOwnedDataRetirementParticipant, listPendingJournals, prepareTransaction, readTransactionJournal,
  type OrdinaryTransactionParticipant, type TransactionFaultSeam, type TransactionOutcome, type TransactionParticipant,
} from "../plugin-lifecycle/transaction.js";
import { projectIdentities } from "../util/project-identity.js";
import type { McpMutationScope, McpReviewRecord, McpReviewSnapshot } from "./model.js";
import { createMcpReviewDefinitionDigest, MCP_REVIEW_DEFINITION_VERSION, validateAndCopyMcpReviewSnapshot } from "./review-definition.js";
import { MCP_REVIEW_STATE_MAX_BYTES, mcpReviewStatePath, readMcpReviewStateCapture, resetMcpReviewRecords, setMcpReviewRecord } from "./review-state.js";
import { canonicalMcpJsonBytes, createMcpTransactionCodec, type McpCurrentAuthority, type McpFormatEvidence, type McpMutationIdentity, type McpParticipantEvidence, type McpTransactionSummary } from "./transaction-codec.js";

const MAX_JSON_BYTES = 1024 * 1024;
const MAX_INPUT_DEPTH = 10;
const MAX_INPUT_PROPERTIES = 4096;
const MAX_INPUT_CHARS = 256 * 1024;
const retainedMcpLeases = new Map<string, Map<string, LifecycleLockLease>>();
const retainedLeaseStores = new WeakMap<LifecycleLockLease, OwnedStateStore>();
function retainedLeases(store: OwnedStateStore): Map<string, LifecycleLockLease> { const key = path.resolve(store.profileRoot); const existing = retainedMcpLeases.get(key); if (existing !== undefined) return existing; const created = new Map<string, LifecycleLockLease>(); retainedMcpLeases.set(key, created); return created; }
export type McpPersistenceEffect = "changed" | "unchanged" | "uncertain";
export type McpPersistenceCleanup = "complete" | "pending";
export type McpPersistenceReasonCode = "no-op" | "already-exists" | "invalid-authority" | "invalid-input" | "invalid-state" | "ambiguous-project-state" | "stale" | "busy" | "storage-failure" | "pending-recovery" | "cleanup-pending";
export interface McpPersistenceDeclarationEvidence { readonly scope: McpMutationScope; readonly name: string; readonly definitionVersion: 1; readonly definitionDigest: string }
interface ResultBase { readonly retrySafe: boolean; readonly effect: McpPersistenceEffect; readonly cleanup: McpPersistenceCleanup; readonly reasonCode?: McpPersistenceReasonCode; readonly reason?: string }
export type McpPersistenceResult =
  | (ResultBase & { readonly state: "committed"; readonly operationId?: string })
  | (ResultBase & { readonly state: "rolled-back"; readonly operationId: string })
  | (ResultBase & { readonly state: "failed-before-commit"; readonly operationId: string })
  | (ResultBase & { readonly state: "stale" | "busy" | "rejected" })
  | (ResultBase & { readonly state: "pending-recovery"; readonly operationId: string });

const declarationEvidenceByResult = new WeakMap<object, McpPersistenceDeclarationEvidence>();
export function mcpPersistenceDeclarationEvidence(result: McpPersistenceResult): McpPersistenceDeclarationEvidence | undefined { return declarationEvidenceByResult.get(result); }

export type McpPersistenceMutation =
  | { readonly kind: "set-declaration"; readonly scope: McpMutationScope; readonly name: string; readonly definition: Readonly<Record<string, unknown>> }
  | { readonly kind: "remove-declaration"; readonly scope: McpMutationScope; readonly name: string }
  | { readonly kind: "set-review"; readonly record: McpReviewRecord }
  | { readonly kind: "reset-review" }
  | { readonly kind: "set-runtime-disabled"; readonly name: string; readonly disabled: boolean };

export interface McpPersistenceContext {
  readonly store: OwnedStateStore;
  readonly profilePath: string;
  readonly projectRoot: string;
  readonly checkoutFamilyKey: string;
  readonly authorityFingerprint: string;
  readonly canonicalizeProject?: Parameters<typeof selectNativeProjectRecord>[0]["canonicalizeProject"];
  readonly identifyProject?: Parameters<typeof selectNativeProjectRecord>[0]["identifyProject"];
  readonly processOwnershipProbe?: ProcessOwnershipProbe;
  readonly revalidateAuthority: () => StoreResult<McpCurrentAuthority> | Promise<StoreResult<McpCurrentAuthority>>;
}

interface JsonDocument { readonly value: Record<string, unknown>; readonly bytes?: Buffer; readonly bom: boolean; readonly newline: "\n" | "\r\n"; readonly indent: string; readonly trailing: boolean }
function fail(code: string, message: string): StoreResult<never> { return { ok: false, code, message }; }
function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
const CLAUDE_BUILT_IN_SERVER_NAMES = new Set(["workspace", "claude-in-chrome", "computer-use", "Claude Preview", "Claude Browser"]);
function validName(name: string): boolean { return name.length > 0 && name.length <= 128 && !/[\u0000-\u001f\u007f-\u009f]/u.test(name); }
function validAddName(name: string): boolean { return validName(name) && !CLAUDE_BUILT_IN_SERVER_NAMES.has(name); }
function samePath(left: string, right: string): boolean { return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right; }
function reason(code: McpPersistenceReasonCode): string {
  return ({ "no-op": "The requested MCP state is already current", "already-exists": "An MCP declaration with that name already exists in the selected scope", "invalid-authority": "MCP persistence authority is invalid or changed", "invalid-input": "The MCP mutation input is invalid", "invalid-state": "The target MCP state is malformed or unsafe", "ambiguous-project-state": "Consolidate or remove canonical-equivalent project entries in the selected .claude.json", stale: "The target MCP state changed concurrently", busy: "Another MCP administration operation holds the required lock", "storage-failure": "MCP persistence storage failed before a durable result", "pending-recovery": "MCP rollback remains pending and blocks new writes", "cleanup-pending": "The durable result is terminal but operation artifact cleanup remains pending" })[code];
}
function rejected(code: McpPersistenceReasonCode): McpPersistenceResult { return { state: "rejected", retrySafe: true, effect: "unchanged", cleanup: "complete", reasonCode: code, reason: reason(code) }; }

async function readJson(target: string, absent: boolean): Promise<StoreResult<JsonDocument>> {
  try {
    const handle = await fs.open(target, constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      const opened = await handle.stat({ bigint: true }); const named = await fs.lstat(target, { bigint: true });
      if (!opened.isFile() || opened.nlink !== 1n || !named.isFile() || named.isSymbolicLink() || opened.dev !== named.dev || opened.ino !== named.ino || opened.size > BigInt(MAX_JSON_BYTES) || !samePath(path.resolve(await fs.realpath(target)), path.resolve(target))) throw new Error("unsafe");
      const bytes = await handle.readFile(); const after = await fs.lstat(target, { bigint: true });
      if (bytes.byteLength > MAX_JSON_BYTES || after.dev !== opened.dev || after.ino !== opened.ino || !after.isFile() || after.isSymbolicLink()) throw new Error("changed");
      const bom = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
      let text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bom ? bytes.subarray(3) : bytes);
      const value = JSON.parse(text) as unknown; if (!record(value)) throw new Error("shape");
      const newline = text.includes("\r\n") ? "\r\n" as const : "\n" as const; const indent = /\r?\n([ \t]+)\S/.exec(text)?.[1] ?? "  ";
      return { ok: true, value: { value, bytes: Buffer.from(bytes), bom, newline, indent, trailing: /\r?\n$/.test(text) } };
    } finally { await handle.close(); }
  } catch (error) {
    if (absent && (error as NodeJS.ErrnoException).code === "ENOENT") return { ok: true, value: { value: {}, bom: false, newline: "\n", indent: "  ", trailing: true } };
    return fail("invalid-state", "MCP state is invalid");
  }
}
function renderJson(document: JsonDocument, review: boolean): StoreResult<Buffer> {
  try {
    let text = JSON.stringify(document.value, null, document.indent).replaceAll("\n", document.newline); if (document.trailing) text += document.newline;
    const bytes = Buffer.concat([document.bom ? Buffer.from([0xef, 0xbb, 0xbf]) : Buffer.alloc(0), Buffer.from(text, "utf8")]);
    if (bytes.byteLength > (review ? MCP_REVIEW_STATE_MAX_BYTES : MAX_JSON_BYTES)) return fail("output-limit", "Rendered MCP state exceeds its reader limit");
    const decoded = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(document.bom ? bytes.subarray(3) : bytes)) as unknown;
    if (review) {
      const validated = validateAndCopyMcpReviewSnapshot(decoded);
      if (validated.invalid || validated.snapshot === undefined) return fail("output-schema", "Rendered MCP review state cannot be reopened");
    } else if (!record(decoded)) return fail("output-schema", "Rendered MCP state cannot be reopened");
    return { ok: true, value: bytes };
  } catch { return fail("output-schema", "Rendered MCP state cannot be reopened"); }
}
async function writePrivate(target: string, bytes: Buffer): Promise<void> {
  const handle = await fs.open(target, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
  if (process.platform !== "win32") await fs.chmod(target, 0o600);
}
function safeJsonCopy(value: unknown): StoreResult<unknown> {
  const seen = new Set<object>(); let units = 0; let chars = 0;
  const inspect = (item: unknown, depth: number): void => {
    if (++units > MAX_INPUT_PROPERTIES || depth > MAX_INPUT_DEPTH) throw new Error("budget");
    if (item === null || typeof item === "boolean") return;
    if (typeof item === "number") { if (!Number.isFinite(item)) throw new Error("number"); return; }
    if (typeof item === "string") { if ((chars += item.length) > MAX_INPUT_CHARS) throw new Error("chars"); return; }
    if (typeof item !== "object" || seen.has(item)) throw new Error("shape"); seen.add(item);
    const prototype = Object.getPrototypeOf(item); if (prototype !== Object.prototype && prototype !== null && !Array.isArray(item)) throw new Error("prototype");
    if (Object.getOwnPropertySymbols(item).length > 0) throw new Error("symbols");
    const descriptors = Object.getOwnPropertyDescriptors(item); if (Object.values(descriptors).some((descriptor) => !("value" in descriptor))) throw new Error("accessor");
    if (Array.isArray(item)) {
      const length = descriptors.length?.value; if (!Number.isSafeInteger(length) || length < 0 || length > MAX_INPUT_PROPERTIES || units + length > MAX_INPUT_PROPERTIES) throw new Error("array");
      units += length;
      for (let index = 0; index < length; index += 1) { const descriptor = descriptors[String(index)]; if (descriptor === undefined || !("value" in descriptor)) throw new Error("hole"); inspect(descriptor.value, depth + 1); }
    } else {
      const entries = Object.entries(descriptors); if (units + entries.length > MAX_INPUT_PROPERTIES) throw new Error("properties"); units += entries.length;
      for (const [key, descriptor] of entries) { if (key.length > 256 || (chars += key.length) > MAX_INPUT_CHARS || !("value" in descriptor)) throw new Error("budget"); inspect(descriptor.value, depth + 1); }
    }
    seen.delete(item);
  };
  const copy = (item: unknown): unknown => {
    if (item === null || typeof item !== "object") return item;
    const descriptors = Object.getOwnPropertyDescriptors(item);
    if (Array.isArray(item)) {
      const output: unknown[] = new Array(descriptors.length!.value as number);
      for (let index = 0; index < output.length; index += 1) Object.defineProperty(output, String(index), { value: copy(descriptors[String(index)]!.value), enumerable: true, configurable: true, writable: true });
      return output;
    }
    const output = Object.create(null) as Record<string, unknown>;
    for (const [key, descriptor] of Object.entries(descriptors)) Object.defineProperty(output, key, { value: copy(descriptor.value), enumerable: true, configurable: true, writable: true });
    return output;
  };
  try { inspect(value, 0); const copied = copy(value); const bytes = Buffer.from(JSON.stringify(copied), "utf8"); return bytes.byteLength <= MAX_JSON_BYTES ? { ok: true, value: copied } : fail("invalid-input", "MCP input is invalid"); }
  catch { return fail("invalid-input", "MCP input is invalid"); }
}
export interface McpDeclarationDefinitionBinding {
  readonly definition: Readonly<Record<string, unknown>>;
  readonly definitionVersion: typeof MCP_REVIEW_DEFINITION_VERSION;
  readonly definitionDigest: string;
}

export function bindMcpDeclarationDefinition(name: string, input: Readonly<Record<string, unknown>>): StoreResult<McpDeclarationDefinitionBinding> {
  if (!validAddName(name)) return fail("invalid-input", "MCP definition is invalid");
  const copied = safeJsonCopy(input); if (!copied.ok || !record(copied.value)) return fail("invalid-input", "MCP definition is invalid");
  const validationName = "picc-validation"; const block = Object.create(null) as Record<string, unknown>; block[validationName] = copied.value;
  const entries = normalizeMcpServerBlock(block, "MCP administration"); const entry = entries[0];
  if (entries.length !== 1 || entry === undefined || entry.name !== validationName || entry.skipped || entry.notConfigured) return fail("invalid-input", "MCP definition is invalid");
  const definitionDigest = createMcpReviewDefinitionDigest(entry);
  if (definitionDigest === undefined) return fail("invalid-input", "MCP definition is invalid");
  return { ok: true, value: Object.freeze({ definition: copied.value, definitionVersion: MCP_REVIEW_DEFINITION_VERSION, definitionDigest }) };
}

export function validateMcpDeclarationInput(name: string, input: Readonly<Record<string, unknown>>): StoreResult<Record<string, unknown>> {
  const binding = bindMcpDeclarationDefinition(name, input);
  return binding.ok ? { ok: true, value: binding.value.definition as Record<string, unknown> } : binding;
}
function canonicalEqual(left: unknown, right: unknown): boolean {
  const a = canonicalMcpJsonBytes(left); const b = canonicalMcpJsonBytes(right); return a.ok && b.ok && a.value.equals(b.value);
}
function participantEvidence(context: McpPersistenceContext, role: McpParticipantEvidence["role"], targetPath: string, mutation: McpMutationIdentity, format: McpFormatEvidence, nativeProjectKey?: string): McpParticipantEvidence {
  return Object.freeze({ version: 1, role, targetPath: path.resolve(targetPath), profileKey: context.store.profileKey, checkoutFamilyKey: context.checkoutFamilyKey, authorityFingerprint: context.authorityFingerprint, mutation, format, ...(nativeProjectKey === undefined ? {} : { nativeProjectKey }) });
}
function artifacts(participants: readonly TransactionParticipant[]): string[] { return participants.flatMap((item) => isOwnedDataRetirementParticipant(item) ? [] : [item.stagedPath, ...(item.rollback.kind === "restore-backup" ? [item.rollback.path] : [])]); }
async function cleanupArtifacts(paths: readonly string[]): Promise<boolean> { let clean = true; for (const candidate of new Set(paths)) await fs.rm(candidate, { force: true }).catch(() => { clean = false; }); return clean; }
function terminal(state: "committed" | "rolled-back" | "failed-before-commit", operationId: string, effect: "changed" | "unchanged", retrySafe: boolean, clean: boolean, failure?: McpPersistenceReasonCode): McpPersistenceResult {
  const code = clean ? failure : "cleanup-pending"; return { state, operationId, retrySafe, effect, cleanup: clean ? "complete" : "pending", ...(code === undefined ? {} : { reasonCode: code, reason: reason(code) }) };
}
function cleanupPosture(result: McpPersistenceResult, clean: boolean): McpPersistenceResult { return clean ? result : { ...result, cleanup: "pending", reasonCode: "cleanup-pending", reason: reason("cleanup-pending") }; }
async function mapOutcome(outcome: TransactionOutcome, ownedArtifacts: readonly string[]): Promise<McpPersistenceResult> {
  if (outcome.state === "pending-recovery") return { state: "pending-recovery", operationId: outcome.operationId, retrySafe: false, effect: "uncertain", cleanup: "pending", reasonCode: "pending-recovery", reason: reason("pending-recovery") };
  const clean = await cleanupArtifacts(ownedArtifacts);
  if (outcome.state === "committed") return terminal("committed", outcome.receipt.operationId, "changed", false, clean);
  if (outcome.state === "rolled-back") return terminal("rolled-back", outcome.receipt.operationId, "unchanged", true, clean);
  if (outcome.state === "failed-before-commit") return terminal("failed-before-commit", outcome.receipt.operationId, "unchanged", true, clean, outcome.receipt.failureCategory === "stale-precondition" ? "stale" : "storage-failure");
  return { state: "rejected", retrySafe: true, effect: "unchanged", cleanup: clean ? "complete" : "pending", reasonCode: clean ? "storage-failure" : "cleanup-pending", reason: reason(clean ? "storage-failure" : "cleanup-pending") };
}

function authorityMatches(context: McpPersistenceContext, value: McpCurrentAuthority): boolean { return value.profileKey === context.store.profileKey && value.checkoutFamilyKey === context.checkoutFamilyKey && value.authorityFingerprint === context.authorityFingerprint; }
async function currentAuthority(context: McpPersistenceContext): Promise<StoreResult<McpCurrentAuthority>> {
  try { const result = await context.revalidateAuthority(); return result.ok && authorityMatches(context, result.value) ? result : fail("changed-authority", "MCP authority changed"); }
  catch { return fail("changed-authority", "MCP authority changed"); }
}
function selectionInputs(context: McpPersistenceContext, root: Record<string, unknown>) { return { root, projectRoot: context.projectRoot, rejectMultipleMatches: true, ...(context.canonicalizeProject === undefined ? {} : { canonicalizeProject: context.canonicalizeProject }), ...(context.identifyProject === undefined ? {} : { identifyProject: context.identifyProject }) }; }
function selectionRejection(diagnostic: string): McpPersistenceResult {
  return rejected(diagnostic === "Native Claude project state has ambiguous matching records" ? "ambiguous-project-state" : "invalid-state");
}
async function revalidateParticipant(context: McpPersistenceContext, evidence: McpParticipantEvidence): Promise<StoreResult<void>> {
  if (evidence.role === "native-user-state" || evidence.role === "review-state") return { ok: true, value: undefined };
  if (evidence.role === "project-declarations") {
    const identities = projectIdentities(path.dirname(evidence.targetPath));
    const family = identities[0];
    if (family === undefined || path.basename(evidence.targetPath) !== ".mcp.json") return fail("changed-authority", "Project MCP authority changed");
    const locations = createMcpLifecycleLocations({ homeDir: path.dirname(path.resolve(context.profilePath)), profilePath: path.resolve(context.profilePath), platform: process.platform === "win32" ? "win32" : "posix", project: { activeCheckoutPath: identities.at(-1)!, checkoutFamilyPath: family } });
    return locations.ok && locations.value.checkoutFamilyKey === evidence.checkoutFamilyKey ? { ok: true, value: undefined } : fail("changed-authority", "Project MCP checkout family changed");
  }
  const current = await readJson(path.resolve(context.profilePath), false); if (!current.ok) return current as StoreResult<void>;
  const selected = selectNativeProjectRecord(selectionInputs(context, current.value.value)); if (!selected.ok) return fail("changed-authority", "Native MCP authority changed");
  const key = evidence.nativeProjectKey;
  return key !== undefined && (selected.value.selectedKey === key || (selected.value.selectedKey === undefined && selected.value.matchingKeys.length === 0 && selected.value.familyIdentity === key)) ? { ok: true, value: undefined } : fail("changed-authority", "Native MCP authority changed");
}
function codecFor(context: McpPersistenceContext, reviewPath: string) {
  return createMcpTransactionCodec({ store: context.store, profilePath: path.resolve(context.profilePath), projectMcpPath: path.join(path.resolve(context.projectRoot), ".mcp.json"), checkoutFamilyKey: context.checkoutFamilyKey, authorityFingerprint: context.authorityFingerprint, reviewStatePath: reviewPath, revalidateAuthority: () => currentAuthority(context), revalidateParticipant: (evidence) => revalidateParticipant(context, evidence) });
}
async function recoverPending(context: McpPersistenceContext, reviewPath: string, faults?: TransactionFaultSeam): Promise<McpPersistenceResult | undefined> {
  const pending = await listPendingJournals(context.store); if (!pending.ok) return { state: "pending-recovery", operationId: "unknown", retrySafe: false, effect: "uncertain", cleanup: "pending", reasonCode: "pending-recovery", reason: reason("pending-recovery") };
  if (pending.value.length === 0) return undefined; const operationId = pending.value[0]!; const codec = codecFor(context, reviewPath);
  const registry = createTransactionCodecRegistry([codec]); if (!registry.ok) return { state: "pending-recovery", operationId, retrySafe: false, effect: "uncertain", cleanup: "pending", reasonCode: "pending-recovery", reason: reason("pending-recovery") };
  const preview = await previewRecovery({ store: context.store, operationId, registry: registry.value });
  if (!preview.ok || !preview.value.actions.includes("rollback")) return { state: "pending-recovery", operationId, retrySafe: false, effect: "uncertain", cleanup: "pending", reasonCode: "pending-recovery", reason: reason("pending-recovery") };
  const journal = await readTransactionJournal(context.store, operationId); if (!journal.ok) return { state: "pending-recovery", operationId, retrySafe: false, effect: "uncertain", cleanup: "pending", reasonCode: "pending-recovery", reason: reason("pending-recovery") };
  let held = retainedLeases(context.store).get(operationId);
  if (held === undefined) {
    const acquired = await acquireLifecycleLocks({ store: context.store, operationId, identities: journal.value.requiredLocks, expectedRecoveryOperationId: operationId, ...(context.processOwnershipProbe === undefined ? {} : { processProbe: context.processOwnershipProbe }) });
    if (!acquired.ok) return { state: "pending-recovery", operationId, retrySafe: false, effect: "uncertain", cleanup: "pending", reasonCode: "pending-recovery", reason: reason("pending-recovery") };
    held = acquired.value; retainedLeases(context.store).set(operationId, held);
  }
  const recoveryStore = retainedLeaseStores.get(held) ?? context.store;
  const recovered = await recoverTransaction({ store: recoveryStore, operationId, action: "rollback", confirmedProducerSchema: preview.value.producerSchema, confirmedProducerVersion: preview.value.producerVersion, confirmedPlanDigest: preview.value.planDigest, confirmedConfirmationDigest: preview.value.confirmationDigest, registry: registry.value, lease: held, ...(faults === undefined ? {} : { faults }) });
  if (!recovered.ok) return { state: "pending-recovery", operationId, retrySafe: false, effect: "uncertain", cleanup: "pending", reasonCode: "pending-recovery", reason: reason("pending-recovery") };
  retainedLeases(context.store).delete(operationId); retainedLeaseStores.delete(held); const clean = await cleanupArtifacts(artifacts(recovered.value.participants)); const released = await releaseLifecycleLocks(held).catch(() => ({ ok: false as const })); return cleanupPosture(terminal("rolled-back", operationId, "unchanged", true, clean), released.ok);
}

export async function persistMcpMutation(context: McpPersistenceContext, mutation: McpPersistenceMutation, options: { readonly faults?: TransactionFaultSeam } = {}): Promise<McpPersistenceResult> {
  const ownedArtifacts: string[] = [];
  try {
    const projectMcpPath = path.join(path.resolve(context.projectRoot), ".mcp.json"); const reviewPath = mcpReviewStatePath(context.store, context.checkoutFamilyKey);
    const pending = await listPendingJournals(context.store);
    if (!pending.ok) return { state: "pending-recovery", operationId: "unknown", retrySafe: false, effect: "uncertain", cleanup: "pending", reasonCode: "pending-recovery", reason: reason("pending-recovery") };
    if (pending.value.length > 0) {
      if (!reviewPath.ok) return { state: "pending-recovery", operationId: pending.value[0]!, retrySafe: false, effect: "uncertain", cleanup: "pending", reasonCode: "pending-recovery", reason: reason("pending-recovery") };
      const recovered = await recoverPending(context, reviewPath.value, options.faults); if (recovered !== undefined) return recovered;
    }
    if (!reviewPath.ok || !/^sha256:[a-f0-9]{64}$/.test(context.authorityFingerprint) || !(await currentAuthority(context)).ok) return rejected("invalid-authority");
    if ("name" in mutation && (!validName(mutation.name) || mutation.kind === "set-declaration" && !validAddName(mutation.name))) return rejected("invalid-input");
    let reviewRecord: McpReviewRecord | undefined;
    if (mutation.kind === "set-review") {
      const bounded = safeJsonCopy(mutation.record); if (!bounded.ok) return rejected("invalid-input");
      const copied = validateAndCopyMcpReviewSnapshot({ version: 1, profileKey: context.store.profileKey, checkoutFamilyKey: context.checkoutFamilyKey, records: [bounded.value] });
      reviewRecord = copied.snapshot?.records[0]; if (copied.invalid || reviewRecord === undefined || !validName(reviewRecord.serverName)) return rejected("invalid-input");
    }
    const preparedDefinition = mutation.kind === "set-declaration" ? bindMcpDeclarationDefinition(mutation.name, mutation.definition) : undefined;
    if (preparedDefinition !== undefined && !preparedDefinition.ok) return rejected("invalid-input");

    let target: string; let role: McpParticipantEvidence["role"]; let document: JsonDocument; let operation: McpTransactionSummary["operation"]; let scope: McpMutationScope | undefined; let nativeProjectKey: string | undefined; let beforeValue: unknown;
    if (mutation.kind === "set-review" || mutation.kind === "reset-review") {
      const current = await readMcpReviewStateCapture({ store: context.store, checkoutFamilyKey: context.checkoutFamilyKey }); if (!current.ok) return rejected("invalid-state");
      const updated: StoreResult<McpReviewSnapshot> = mutation.kind === "set-review" ? setMcpReviewRecord(current.value.snapshot, reviewRecord!) : { ok: true, value: resetMcpReviewRecords(current.value.snapshot) }; if (!updated.ok) return rejected("invalid-input");
      if (validateAndCopyMcpReviewSnapshot(updated.value).invalid) return rejected("invalid-input");
      target = reviewPath.value; role = "review-state"; operation = mutation.kind === "set-review" ? "review" : "reset-review"; beforeValue = current.value.snapshot;
      document = { value: updated.value as unknown as Record<string, unknown>, newline: "\n", indent: "  ", trailing: true, bom: false, ...(current.value.bytes === undefined ? {} : { bytes: Buffer.from(current.value.bytes) }) };
    } else {
      scope = mutation.kind === "set-runtime-disabled" ? "local" : mutation.scope; target = scope === "project" ? projectMcpPath : path.resolve(context.profilePath); role = scope === "project" ? "project-declarations" : scope === "user" ? "native-user-state" : "native-project-state";
      const loaded = await readJson(target, scope === "project"); if (!loaded.ok) return rejected("invalid-state"); document = loaded.value; beforeValue = JSON.parse(JSON.stringify(document.value)) as unknown;
      let holder: Record<string, unknown> = document.value; let newLocalRecord = false;
      if (scope === "local") {
        const selected = selectNativeProjectRecord(selectionInputs(context, document.value)); if (!selected.ok) return selectionRejection(selected.diagnostic);
        if (Object.hasOwn(document.value, "projects") && !record(document.value.projects)) return rejected("invalid-state");
        nativeProjectKey = selected.value.selectedKey ?? selected.value.familyIdentity;
        const selectedRecord = selected.value.selectedRecord;
        if (selectedRecord !== undefined && !record(selectedRecord)) return rejected("invalid-state");
        holder = selectedRecord ?? {}; newLocalRecord = selectedRecord === undefined;
      }
      if (mutation.kind === "set-runtime-disabled") {
        if (Object.hasOwn(holder, "disabledMcpServers") && !Array.isArray(holder.disabledMcpServers)) return rejected("invalid-state");
        const current = holder.disabledMcpServers as unknown[] | undefined;
        if (current !== undefined && current.some((item) => typeof item !== "string" || !validName(item))) return rejected("invalid-state");
        const names = current as string[] | undefined ?? [];
        if (mutation.disabled) holder.disabledMcpServers = [...new Set([...names, mutation.name])]; else if (current !== undefined) holder.disabledMcpServers = names.filter((name) => name !== mutation.name);
      } else {
        if (Object.hasOwn(holder, "mcpServers") && !record(holder.mcpServers)) return rejected("invalid-state");
        if (mutation.kind === "set-declaration") {
          const servers = Object.hasOwn(holder, "mcpServers") ? holder.mcpServers as Record<string, unknown> : (holder.mcpServers = {});
          if (Object.hasOwn(servers, mutation.name)) return rejected("already-exists");
          Object.defineProperty(servers, mutation.name, { value: preparedDefinition!.value.definition, enumerable: true, configurable: true, writable: true });
        } else if (Object.hasOwn(holder, "mcpServers")) delete (holder.mcpServers as Record<string, unknown>)[mutation.name];
      }
      if (scope === "local" && newLocalRecord && !canonicalEqual(holder, {})) {
        const projects = Object.hasOwn(document.value, "projects") ? document.value.projects as Record<string, unknown> : (document.value.projects = {});
        Object.defineProperty(projects, nativeProjectKey!, { value: holder, enumerable: true, configurable: true, writable: true });
      }
      operation = mutation.kind === "set-runtime-disabled" ? "runtime-disable" : "declaration";
    }
    const declarationEvidence = mutation.kind === "set-declaration" ? { scope: mutation.scope, name: mutation.name, definitionVersion: preparedDefinition!.value.definitionVersion, definitionDigest: preparedDefinition!.value.definitionDigest } as const : undefined;
    if (canonicalEqual(beforeValue, document.value)) { const result: McpPersistenceResult = { state: "committed", retrySafe: true, effect: "unchanged", cleanup: "complete", reasonCode: "no-op", reason: reason("no-op") }; if (declarationEvidence !== undefined) declarationEvidenceByResult.set(result, declarationEvidence); return result; }
    let mutationIdentity: McpMutationIdentity;
    if (mutation.kind === "set-declaration") { const canonical = canonicalMcpJsonBytes(preparedDefinition!.value.definition); if (!canonical.ok) return rejected("invalid-input"); mutationIdentity = { kind: "set-declaration", scope: mutation.scope, serverName: mutation.name, definitionDigest: sha256(canonical.value) }; }
    else if (mutation.kind === "remove-declaration") mutationIdentity = { kind: "remove-declaration", scope: mutation.scope, serverName: mutation.name };
    else if (mutation.kind === "set-runtime-disabled") mutationIdentity = { kind: "set-runtime-disabled", serverName: mutation.name, disabled: mutation.disabled };
    else if (mutation.kind === "set-review") mutationIdentity = { kind: "set-review", source: reviewRecord!.source, serverName: reviewRecord!.serverName, ...(reviewRecord!.agentOwner === undefined ? {} : { agentOwner: reviewRecord!.agentOwner }), definitionDigest: reviewRecord!.definitionDigest, decision: reviewRecord!.decision };
    else mutationIdentity = { kind: "reset-review" };
    const rendered = renderJson(document, role === "review-state"); if (!rendered.ok) return rejected("invalid-state"); const nextBytes = rendered.value;
    const operationId = `mcp_${randomBytes(16).toString("hex")}`; const stagedPath = path.join(context.store.stagingRoot, `${operationId}-0.staged`); ownedArtifacts.push(stagedPath); await writePrivate(stagedPath, nextBytes);
    let rollback: OrdinaryTransactionParticipant["rollback"]; let precondition: OrdinaryTransactionParticipant["precondition"];
    if (document.bytes === undefined) { precondition = { state: "absent" }; rollback = { kind: "delete-new-target" }; }
    else { const digest = sha256(document.bytes); const backup = path.join(context.store.stagingRoot, `${operationId}-0.backup`); ownedArtifacts.push(backup); await writePrivate(backup, document.bytes); precondition = { state: "present", digest }; rollback = { kind: "restore-backup", path: backup, digest }; }
    const participant: OrdinaryTransactionParticipant = { kind: "mcp-state", key: "mcp-state", ownerKey: "mcp-review", scopeKey: context.checkoutFamilyKey, targetPath: target, targetClass: "external", precondition, stagedPath, stagedDigest: sha256(nextBytes), rollback, producerEvidence: participantEvidence(context, role, target, mutationIdentity, { bom: document.bom, newline: document.newline, indent: document.indent, trailing: document.trailing }, role === "native-project-state" ? nativeProjectKey : undefined) };
    const summary: McpTransactionSummary = { version: 1, profileKey: context.store.profileKey, checkoutFamilyKey: context.checkoutFamilyKey, operation, ...(operation === "declaration" ? { scope: scope! } : {}), mutation: mutationIdentity, authorityFingerprint: context.authorityFingerprint, targets: [path.resolve(target)] };
    const codec = codecFor(context, reviewPath.value); const prepared = await prepareTransaction({ store: context.store, codec, operationId, confirmationSummary: summary, participants: [participant] });
    if (!prepared.ok) { const clean = await cleanupArtifacts(ownedArtifacts); return { state: prepared.code === "stale-precondition" ? "stale" : "rejected", retrySafe: true, effect: "unchanged", cleanup: clean ? "complete" : "pending", reasonCode: clean ? prepared.code === "stale-precondition" ? "stale" : "storage-failure" : "cleanup-pending", reason: reason(clean ? prepared.code === "stale-precondition" ? "stale" : "storage-failure" : "cleanup-pending") }; }
    const locks = codec.requiredLocks(summary, prepared.value.participants); if (!locks.ok) { const clean = await cleanupArtifacts(ownedArtifacts); return { ...rejected(clean ? "storage-failure" : "cleanup-pending"), cleanup: clean ? "complete" : "pending" }; }
    const lease = await acquireLifecycleLocks({ store: context.store, operationId, identities: locks.value, ...(context.processOwnershipProbe === undefined ? {} : { processProbe: context.processOwnershipProbe }) });
    if (!lease.ok) { const clean = await cleanupArtifacts(ownedArtifacts); return { state: lease.code === "lock-busy" ? "busy" : "rejected", retrySafe: true, effect: "unchanged", cleanup: clean ? "complete" : "pending", reasonCode: clean ? lease.code === "lock-busy" ? "busy" : "storage-failure" : "cleanup-pending", reason: reason(clean ? lease.code === "lock-busy" ? "busy" : "storage-failure" : "cleanup-pending") }; }
    const result = await mapOutcome(await executeTransaction(context.store, prepared.value, { lease: lease.value, ...(options.faults === undefined ? {} : { faults: options.faults }) }), ownedArtifacts);
    if (result.state === "committed" && declarationEvidence !== undefined) declarationEvidenceByResult.set(result, declarationEvidence);
    if (result.state === "pending-recovery") { retainedLeases(context.store).set(operationId, lease.value); retainedLeaseStores.set(lease.value, context.store); return result; }
    const released = await releaseLifecycleLocks(lease.value).catch(() => ({ ok: false as const })); return cleanupPosture(result, released.ok);
  } catch {
    const clean = await cleanupArtifacts(ownedArtifacts); return { state: "rejected", retrySafe: true, effect: "unchanged", cleanup: clean ? "complete" : "pending", reasonCode: clean ? "storage-failure" : "cleanup-pending", reason: reason(clean ? "storage-failure" : "cleanup-pending") };
  }
}

export async function recoverMcpPendingOperation(context: McpPersistenceContext, options: { readonly faults?: TransactionFaultSeam } = {}): Promise<McpPersistenceResult> {
  try {
    const reviewPath = mcpReviewStatePath(context.store, context.checkoutFamilyKey);
    if (!reviewPath.ok || !/^sha256:[a-f0-9]{64}$/.test(context.authorityFingerprint) || !(await currentAuthority(context)).ok) return rejected("invalid-authority");
    const recovered = await recoverPending(context, reviewPath.value, options.faults);
    return recovered ?? { state: "committed", retrySafe: true, effect: "unchanged", cleanup: "complete", reasonCode: "no-op", reason: reason("no-op") };
  } catch {
    return rejected("storage-failure");
  }
}

export interface McpPendingOperationProjection { readonly pending: boolean; readonly operationId?: string; readonly status: "clear" | "pending" | "invalid" }
export async function inspectMcpPendingOperation(store: OwnedStateStore): Promise<McpPendingOperationProjection> {
  const pending = await listPendingJournals(store); if (!pending.ok) return Object.freeze({ pending: true, status: "invalid" });
  return pending.value.length === 0 ? Object.freeze({ pending: false, status: "clear" }) : Object.freeze({ pending: true, status: "pending", operationId: pending.value[0] });
}

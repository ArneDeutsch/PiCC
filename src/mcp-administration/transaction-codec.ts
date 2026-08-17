import { promises as fs } from "node:fs";
import path from "node:path";
import { canonicalJsonBytes, sha256, type OwnedStateStore, type StoreResult } from "../plugin-lifecycle/state-store.js";
import type { LifecycleLockIdentity } from "../plugin-lifecycle/locks.js";
import { isOwnedDataRetirementParticipant, type ExternalMutationContext, type OrdinaryTransactionParticipant, type TransactionParticipant, type TransactionProducerCodec } from "../plugin-lifecycle/transaction.js";
import { validateAndCopyMcpReviewSnapshot } from "./review-definition.js";
import type { McpAdministrationSource, McpAgentOwner, McpMutationScope } from "./model.js";

export const MCP_TRANSACTION_SCHEMA = "mcp-administration";
export const MCP_TRANSACTION_VERSION = 1 as const;

export type McpMutationIdentity =
  | { readonly kind: "set-declaration"; readonly scope: McpMutationScope; readonly serverName: string; readonly definitionDigest: string }
  | { readonly kind: "remove-declaration"; readonly scope: McpMutationScope; readonly serverName: string }
  | { readonly kind: "set-runtime-disabled"; readonly serverName: string; readonly disabled: boolean }
  | { readonly kind: "set-review"; readonly source: McpAdministrationSource; readonly serverName: string; readonly agentOwner?: McpAgentOwner; readonly definitionDigest: string; readonly decision: "approved" | "rejected" }
  | { readonly kind: "reset-review" };

export interface McpFormatEvidence { readonly bom: boolean; readonly newline: "\n" | "\r\n"; readonly indent: string; readonly trailing: boolean }

export interface McpTransactionSummary {
  readonly version: 1;
  readonly profileKey: string;
  readonly checkoutFamilyKey: string;
  readonly operation: "declaration" | "review" | "runtime-disable" | "reset-review";
  readonly scope?: McpMutationScope;
  readonly mutation: McpMutationIdentity;
  readonly authorityFingerprint: string;
  readonly targets: readonly string[];
}

export interface McpParticipantEvidence {
  readonly version: 1;
  readonly role: "project-declarations" | "native-user-state" | "native-project-state" | "review-state";
  readonly targetPath: string;
  readonly profileKey: string;
  readonly checkoutFamilyKey: string;
  readonly authorityFingerprint: string;
  readonly nativeProjectKey?: string;
  readonly mutation: McpMutationIdentity;
  readonly format: McpFormatEvidence;
}

export interface McpCurrentAuthority {
  readonly profileKey: string;
  readonly checkoutFamilyKey: string;
  readonly authorityFingerprint: string;
}

function fail(code: string, message: string): StoreResult<never> { return { ok: false, code, message }; }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function samePath(left: string, right: string): boolean { return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right; }
function validScope(value: unknown): value is McpMutationScope { return value === "project" || value === "local" || value === "user"; }
function validName(value: unknown): value is string { return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value) && !value.includes("__"); }
function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean { const actual = Object.keys(value).sort(); const expected = [...keys].sort(); return actual.length === expected.length && actual.every((key, index) => key === expected[index]); }
function validDigest(value: unknown): value is string { return typeof value === "string" && /^(?:sha256|mcp-review-v1):[a-f0-9]{64}$/.test(value); }
function mutationIdentity(value: unknown): McpMutationIdentity | undefined {
  if (!isRecord(value) || typeof value.kind !== "string") return undefined;
  if (value.kind === "reset-review") return exactKeys(value, ["kind"]) ? { kind: "reset-review" } : undefined;
  if (!validName(value.serverName)) return undefined;
  if (value.kind === "set-declaration" && exactKeys(value, ["definitionDigest", "kind", "scope", "serverName"]) && validScope(value.scope) && validDigest(value.definitionDigest) && String(value.definitionDigest).startsWith("sha256:")) return value as unknown as McpMutationIdentity;
  if (value.kind === "remove-declaration" && exactKeys(value, ["kind", "scope", "serverName"]) && validScope(value.scope)) return value as unknown as McpMutationIdentity;
  if (value.kind === "set-runtime-disabled" && exactKeys(value, ["disabled", "kind", "serverName"]) && typeof value.disabled === "boolean") return value as unknown as McpMutationIdentity;
  const reviewKeys = value.agentOwner === undefined ? ["decision", "definitionDigest", "kind", "serverName", "source"] : ["agentOwner", "decision", "definitionDigest", "kind", "serverName", "source"];
  if (value.kind === "set-review" && exactKeys(value, reviewKeys) && typeof value.source === "string" && validDigest(value.definitionDigest) && String(value.definitionDigest).startsWith("mcp-review-v1:") && (value.decision === "approved" || value.decision === "rejected") &&
    (value.agentOwner === undefined || (isRecord(value.agentOwner) && exactKeys(value.agentOwner, ["name", "scope"]) && validName(value.agentOwner.name) && (value.agentOwner.scope === "project" || value.agentOwner.scope === "user")))) return value as unknown as McpMutationIdentity;
  return undefined;
}
function formatEvidence(value: unknown): McpFormatEvidence | undefined {
  if (!isRecord(value) || !exactKeys(value, ["bom", "indent", "newline", "trailing"]) || typeof value.bom !== "boolean" || (value.newline !== "\n" && value.newline !== "\r\n") || typeof value.indent !== "string" || value.indent.length > 16 || typeof value.trailing !== "boolean") return undefined;
  return value as unknown as McpFormatEvidence;
}
function canonicallyEqual(left: unknown, right: unknown): boolean { const a = canonicalJsonBytes(left); const b = canonicalJsonBytes(right); return a.ok && b.ok && Buffer.from(a.value).equals(Buffer.from(b.value)); }

export function decodeMcpTransactionSummary(value: unknown, store: OwnedStateStore): StoreResult<McpTransactionSummary> {
  if (!isRecord(value) || value.version !== 1 || value.profileKey !== store.profileKey ||
    typeof value.checkoutFamilyKey !== "string" || !/^checkout-[A-Za-z0-9_-]+$/.test(value.checkoutFamilyKey) ||
    !["declaration", "review", "runtime-disable", "reset-review"].includes(String(value.operation)) ||
    typeof value.authorityFingerprint !== "string" || !/^sha256:[a-f0-9]{64}$/.test(value.authorityFingerprint) ||
    !Array.isArray(value.targets) || value.targets.length !== 1 ||
    value.targets.some((item) => typeof item !== "string" || !path.isAbsolute(item)) || mutationIdentity(value.mutation) === undefined ||
    (value.operation === "declaration" ? !validScope(value.scope) || (value.mutation as { scope?: unknown }).scope !== value.scope || !["set-declaration", "remove-declaration"].includes(String((value.mutation as { kind?: unknown }).kind))
      : value.scope !== undefined || (value.operation === "review" ? (value.mutation as { kind?: unknown }).kind !== "set-review" : value.operation === "runtime-disable" ? (value.mutation as { kind?: unknown }).kind !== "set-runtime-disabled" : (value.mutation as { kind?: unknown }).kind !== "reset-review"))) return fail("invalid-summary", "MCP transaction summary is invalid");
  return { ok: true, value: value as unknown as McpTransactionSummary };
}

function evidence(participant: OrdinaryTransactionParticipant): McpParticipantEvidence | undefined {
  const value = participant.producerEvidence;
  if (!isRecord(value) || value.version !== 1 || !["project-declarations", "native-user-state", "native-project-state", "review-state"].includes(String(value.role)) ||
    typeof value.targetPath !== "string" || typeof value.profileKey !== "string" || typeof value.checkoutFamilyKey !== "string" ||
    typeof value.authorityFingerprint !== "string" || (value.nativeProjectKey !== undefined && typeof value.nativeProjectKey !== "string") || mutationIdentity(value.mutation) === undefined || formatEvidence(value.format) === undefined) return undefined;
  return value as unknown as McpParticipantEvidence;
}

function decodeDocument(bytes: Buffer): Record<string, unknown> | undefined {
  try {
    const bom = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
    const value = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bom ? bytes.subarray(3) : bytes)) as unknown;
    return isRecord(value) ? value : undefined;
  } catch { return undefined; }
}
function renderDocument(value: Record<string, unknown>, format: McpFormatEvidence): Buffer {
  let text = JSON.stringify(value, null, format.indent).replaceAll("\n", format.newline); if (format.trailing) text += format.newline;
  return Buffer.concat([format.bom ? Buffer.from([0xef, 0xbb, 0xbf]) : Buffer.alloc(0), Buffer.from(text, "utf8")]);
}
function sameReviewOwner(left: Record<string, unknown>, mutation: Extract<McpMutationIdentity, { kind: "set-review" }>, evidence: McpParticipantEvidence): boolean {
  const owner = isRecord(left.agentOwner) ? left.agentOwner : undefined;
  return left.profileKey === evidence.profileKey && left.checkoutFamilyKey === evidence.checkoutFamilyKey && left.source === mutation.source && left.serverName === mutation.serverName &&
    owner?.name === mutation.agentOwner?.name && owner?.scope === mutation.agentOwner?.scope;
}
async function validateSurgicalSuccessor(participant: OrdinaryTransactionParticipant, item: McpParticipantEvidence): Promise<StoreResult<void>> {
  try {
    const beforeBytes = participant.precondition.state === "present" && participant.rollback.kind === "restore-backup" ? await fs.readFile(participant.rollback.path) : undefined;
    const stagedBytes = await fs.readFile(participant.stagedPath);
    const before = beforeBytes === undefined ? {} : decodeDocument(beforeBytes); const staged = decodeDocument(stagedBytes);
    if (before === undefined || staged === undefined) return fail("invalid-successor", "MCP transaction payload cannot be reconstructed");
    const expected = JSON.parse(JSON.stringify(before)) as Record<string, unknown>; const mutation = item.mutation;
    if (mutation.kind === "set-review" || mutation.kind === "reset-review") {
      if (beforeBytes === undefined) { expected.version = 1; expected.profileKey = item.profileKey; expected.checkoutFamilyKey = item.checkoutFamilyKey; expected.records = []; }
      const validatedStaged = validateAndCopyMcpReviewSnapshot(staged); if (validatedStaged.invalid || validatedStaged.snapshot === undefined) return fail("invalid-successor", "MCP review successor is invalid");
      if (mutation.kind === "reset-review") expected.records = [];
      else {
        const record = validatedStaged.snapshot.records.find((candidate) => sameReviewOwner(candidate as unknown as Record<string, unknown>, mutation, item));
        if (record === undefined || record.definitionDigest !== mutation.definitionDigest || record.decision !== mutation.decision) return fail("invalid-successor", "MCP review mutation identity changed");
        const current = Array.isArray(expected.records) ? expected.records.filter((candidate) => !isRecord(candidate) || !sameReviewOwner(candidate, mutation, item)) : [];
        current.push(record); expected.records = current;
      }
    } else {
      let expectedHolder = expected; let stagedHolder = staged;
      if (mutation.kind === "set-runtime-disabled" || mutation.scope === "local") {
        const key = item.nativeProjectKey; if (key === undefined) return fail("invalid-successor", "Native project mutation identity is absent");
        const expectedProjects = Object.hasOwn(expected, "projects") && isRecord(expected.projects) ? expected.projects : (expected.projects = Object.create(null) as Record<string, unknown>);
        const stagedProjects = isRecord(staged.projects) ? staged.projects : undefined;
        const oldRecord = expectedProjects[key]; expectedHolder = isRecord(oldRecord) ? oldRecord : (expectedProjects[key] = Object.create(null) as Record<string, unknown>);
        stagedHolder = stagedProjects !== undefined && isRecord(stagedProjects[key]) ? stagedProjects[key] : Object.create(null) as Record<string, unknown>;
      }
      if (mutation.kind === "set-runtime-disabled") {
        const old = Array.isArray(expectedHolder.disabledMcpServers) ? expectedHolder.disabledMcpServers as unknown[] : [];
        if (old.some((value) => typeof value !== "string")) return fail("invalid-successor", "Native disable precondition is invalid");
        expectedHolder.disabledMcpServers = mutation.disabled ? [...new Set([...(old as string[]), mutation.serverName])] : (old as string[]).filter((name) => name !== mutation.serverName);
      } else {
        const expectedServers = Object.hasOwn(expectedHolder, "mcpServers") && isRecord(expectedHolder.mcpServers) ? expectedHolder.mcpServers : (expectedHolder.mcpServers = Object.create(null) as Record<string, unknown>);
        if (mutation.kind === "remove-declaration") delete expectedServers[mutation.serverName];
        else {
          const stagedServers = isRecord(stagedHolder.mcpServers) ? stagedHolder.mcpServers : undefined; const definition = stagedServers?.[mutation.serverName];
          const canonical = canonicalJsonBytes(definition); if (!canonical.ok || sha256(canonical.value) !== mutation.definitionDigest) return fail("invalid-successor", "MCP declaration digest changed");
          expectedServers[mutation.serverName] = definition;
        }
      }
    }
    const expectedBytes = renderDocument(expected, item.format);
    return expectedBytes.equals(stagedBytes) ? { ok: true, value: undefined } : fail("invalid-successor", "MCP staged payload changes state outside its mutation identity");
  } catch { return fail("invalid-successor", "MCP transaction payload cannot be reconstructed"); }
}

export function createMcpTransactionCodec(inputs: {
  readonly store: OwnedStateStore;
  readonly profilePath: string;
  readonly projectMcpPath: string;
  readonly checkoutFamilyKey: string;
  readonly authorityFingerprint: string;
  readonly reviewStatePath: string;
  readonly revalidateAuthority: () => StoreResult<McpCurrentAuthority> | Promise<StoreResult<McpCurrentAuthority>>;
  readonly revalidateParticipant: (evidence: McpParticipantEvidence) => StoreResult<void> | Promise<StoreResult<void>>;
}): TransactionProducerCodec<McpTransactionSummary> {
  const profilePath = path.resolve(inputs.profilePath); const reviewPath = path.resolve(inputs.reviewStatePath);
  const decode = (value: unknown) => decodeMcpTransactionSummary(value, inputs.store);
  const validateEvidence = (participant: OrdinaryTransactionParticipant): StoreResult<McpParticipantEvidence> => {
    const item = evidence(participant); const target = path.resolve(participant.targetPath);
    if (item === undefined || !samePath(target, path.resolve(item.targetPath)) ||
      item.profileKey !== inputs.store.profileKey || item.checkoutFamilyKey !== inputs.checkoutFamilyKey || item.authorityFingerprint !== inputs.authorityFingerprint) return fail("invalid-authority", "MCP participant authority is invalid");
    const exactPrivate = samePath(target, reviewPath); const exactProfile = samePath(target, profilePath);
    const targetClassValid = item.role === "review-state" ? exactPrivate && participant.targetClass === "external"
      : item.role === "native-user-state" ? exactProfile && participant.targetClass === "external" && item.nativeProjectKey === undefined
      : item.role === "native-project-state" ? exactProfile && participant.targetClass === "external" && item.nativeProjectKey !== undefined
      : item.role === "project-declarations" && participant.targetClass === "external" && path.basename(target) === ".mcp.json";
    if (!targetClassValid || (item.role !== "native-project-state" && item.nativeProjectKey !== undefined)) return fail("invalid-authority", "MCP participant target class is invalid");
    return { ok: true, value: item };
  };
  const validatePlanAndSummary = (summary: McpTransactionSummary, participants: readonly TransactionParticipant[]): StoreResult<void> => {
    if (participants.length !== 1 || participants.some(isOwnedDataRetirementParticipant)) return fail("invalid-plan", "MCP transaction plan is invalid");
    const participant = participants[0] as OrdinaryTransactionParticipant; const checked = validateEvidence(participant); if (!checked.ok) return checked;
    if (!samePath(summary.targets[0]!, participant.targetPath) || !canonicallyEqual(summary.mutation, checked.value.mutation)) return fail("invalid-plan", "MCP transaction targets or mutation identity do not match participants");
    const role = checked.value.role;
    if ((summary.operation === "review" || summary.operation === "reset-review") ? role !== "review-state"
      : summary.operation === "runtime-disable" ? role !== "native-project-state"
      : summary.scope === "project" ? role !== "project-declarations" : summary.scope === "user" ? role !== "native-user-state" : role !== "native-project-state") return fail("invalid-plan", "MCP operation and participant role disagree");
    return { ok: true, value: undefined };
  };
  const fresh = async (participant: OrdinaryTransactionParticipant): Promise<StoreResult<void>> => {
    const checked = validateEvidence(participant); if (!checked.ok) return checked;
    const authority = await inputs.revalidateAuthority();
    if (!authority.ok || authority.value.profileKey !== inputs.store.profileKey || authority.value.checkoutFamilyKey !== inputs.checkoutFamilyKey || authority.value.authorityFingerprint !== inputs.authorityFingerprint) return fail("changed-authority", "MCP persistence authority changed");
    const participantAuthority = await inputs.revalidateParticipant(checked.value); if (!participantAuthority.ok) return participantAuthority;
    return validateSurgicalSuccessor(participant, checked.value);
  };
  return Object.freeze({
    schema: MCP_TRANSACTION_SCHEMA,
    version: MCP_TRANSACTION_VERSION,
    decodeSummary: decode,
    validatePlan: (participants: readonly TransactionParticipant[]) => {
      if (participants.length !== 1 || isOwnedDataRetirementParticipant(participants[0]!)) return fail("invalid-plan", "MCP transaction plan is invalid");
      return validateEvidence(participants[0] as OrdinaryTransactionParticipant).ok ? { ok: true as const, value: undefined } : fail("invalid-plan", "MCP transaction plan is invalid");
    },
    requiredLocks: (raw: unknown, participants: readonly TransactionParticipant[]) => {
      const summary = decode(raw); if (!summary.ok) return summary as StoreResult<readonly LifecycleLockIdentity[]>;
      const valid = validatePlanAndSummary(summary.value, participants); if (!valid.ok) return valid as StoreResult<readonly LifecycleLockIdentity[]>;
      const participant = participants[0] as OrdinaryTransactionParticipant;
      const locks: LifecycleLockIdentity[] = [{ kind: "profile", key: inputs.store.profileKey }, { kind: "checkout", key: inputs.checkoutFamilyKey }];
      if (participant.targetClass === "external") locks.push({ kind: "settings", key: path.resolve(participant.targetPath) });
      return { ok: true as const, value: locks };
    },
    authorizeExternal: async ({ participant }: ExternalMutationContext) => {
      const valid = await fresh(participant); if (!valid.ok) return valid;
      return { ok: true as const, value: samePath(participant.targetPath, profilePath) || samePath(participant.targetPath, reviewPath) ? { temporaryMode: 0o600 } : undefined };
    },
    authorizeOwnedReplace: async ({ participant }: ExternalMutationContext) => fresh(participant),
  });
}

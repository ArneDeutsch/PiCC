import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Diagnostic, PluginRuntimeContext } from "../types.js";
import { isQualifiedPluginId } from "../util/plugin-id.js";
import { getAdmittedInstallationEvidence, isCompleteOwnedProfileReference, readOwnedAdmissionRecords, reconstructOwnedDataRetirementProducerEvidence, type CompleteOwnedProfileReference, type OwnedDataRetirementProducerEvidence, type OwnedPluginInstallationRecord } from "../plugin-lifecycle/admission.js";
import { canonicalJsonBytes, readRecordEnvelope, revalidateOwnedStateStore, sha256, type OwnedStateStore, type StoreResult } from "../plugin-lifecycle/state-store.js";
import { isAuthenticOwnedDataRetirementMutationContext, isOwnedDataRetirementParticipant, type OrdinaryTransactionParticipant, type OwnedDataRetirementMutationContext } from "../plugin-lifecycle/transaction.js";

function samePath(left: string, right: string): boolean { return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right; }

const WINDOWS_RESERVED_NAME = /^(?:con|prn|aux|nul|clock\$|com[1-9]|lpt[1-9]|conin\$|conout\$)(?:\..*)?$/i;
const authorizedPluginRootBrand: unique symbol = Symbol("AuthorizedPluginRoot");
const claudeUserDirectoryBrand: unique symbol = Symbol("ClaudeUserDirectory");
const validatedPluginPathBrand: unique symbol = Symbol("ValidatedPluginPath");
const pluginDataLocationBrand: unique symbol = Symbol("PluginDataLocation");
const ownedPluginDataLocationBrand: unique symbol = Symbol("OwnedPluginDataLocation");

export type PluginPathKind = "file" | "directory" | "either";
export type PluginPathInputKind = "explicit" | "generated";
export type PluginPathFailureCode =
  | "invalid-path"
  | "unreadable-path"
  | "path-escape"
  | "wrong-kind"
  | "changed-path"
  | "walk-failure";

export interface PluginPathFailure {
  ok: false;
  code: PluginPathFailureCode;
  diagnostic: Diagnostic;
}

export interface AuthorizedPluginRoot {
  readonly lexicalPath: string;
  readonly canonicalPath: string;
  readonly [authorizedPluginRootBrand]: true;
}

export interface ClaudeUserDirectory {
  readonly lexicalPath: string;
  readonly canonicalPath: string;
  readonly [claudeUserDirectoryBrand]: true;
}

export interface ValidatedPluginPath {
  readonly root: AuthorizedPluginRoot;
  readonly inputKind: PluginPathInputKind;
  readonly declaredPath: string;
  readonly relativePath: string;
  readonly lexicalPath: string;
  readonly canonicalPath: string;
  readonly kind: "file" | "directory";
  readonly [validatedPluginPathBrand]: true;
}

export type PluginPathResult<T> = { ok: true; value: T } | PluginPathFailure;

export interface PluginWalkResult {
  files: ValidatedPluginPath[];
  failures: PluginPathFailure[];
  diagnostics: Diagnostic[];
}

export interface PluginDataLocation {
  readonly qualifiedIdentity: string;
  readonly key: string;
  readonly collisionToken: string;
  readonly userDir: ClaudeUserDirectory;
  readonly lexicalBasePath: string;
  readonly canonicalBasePath: string;
  readonly lexicalPath: string;
  readonly canonicalPath: string;
  readonly [pluginDataLocationBrand]: true;
}

export interface OwnedPluginDataLocation {
  readonly ownership: "picc-owned";
  readonly qualifiedIdentity: string;
  readonly profileKey: string;
  readonly profileRoot: AuthorizedPluginRoot;
  readonly lexicalBasePath: string;
  readonly canonicalBasePath: string;
  readonly lexicalPath: string;
  readonly canonicalPath: string;
  readonly [ownedPluginDataLocationBrand]: true;
}

export type AuthorizedPluginDataLocation =
  | { readonly ownership: "claude-imported-readonly"; readonly location: PluginDataLocation }
  | OwnedPluginDataLocation;

const runtimeDataAuthorities = new WeakMap<PluginRuntimeContext, AuthorizedPluginDataLocation>();

function failure(
  code: PluginPathFailureCode,
  message: string,
  source?: string,
): PluginPathFailure {
  return {
    ok: false,
    code,
    diagnostic: { severity: "warning", message, ...(source === undefined ? {} : { source }) },
  };
}

function realpathNative(value: string): string {
  return fs.realpathSync.native(value);
}

function isContained(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

function actualKind(value: string): "file" | "directory" | undefined {
  try {
    const stat = fs.statSync(value);
    if (stat.isFile()) return "file";
    if (stat.isDirectory()) return "directory";
  } catch {
    return undefined;
  }
  return undefined;
}

function validateRelativePath(
  declaredPath: string,
  inputKind: PluginPathInputKind,
): PluginPathResult<string> {
  if (declaredPath.length === 0 || declaredPath.includes("\0")) {
    return failure("invalid-path", "Plugin path is empty or contains a NUL byte");
  }
  if (inputKind === "explicit" && !declaredPath.startsWith("./")) {
    return failure("invalid-path", 'Explicit plugin paths must begin with "./"');
  }
  if (
    declaredPath.startsWith("/") ||
    declaredPath.startsWith("\\") ||
    /^[A-Za-z]:/.test(declaredPath) ||
    /^(?:\\\\|\/\/)[?.](?:\\|\/)/.test(declaredPath) ||
    /^(?:\\|\/)(?:\?\?|GLOBALROOT)(?:\\|\/)/i.test(declaredPath)
  ) {
    return failure("invalid-path", "Plugin path must not use an absolute, rooted, drive, UNC, or device form");
  }

  const portable = declaredPath.replaceAll("\\", "/");
  const withoutPrefix = inputKind === "explicit" ? portable.slice(2) : portable;
  if (inputKind === "explicit" && withoutPrefix === "") {
    return { ok: true, value: "" };
  }
  const parts = withoutPrefix.split("/");
  if (parts.at(-1) === "" && parts.length > 1) parts.pop();
  if (parts.some((part) => part === "..")) {
    return failure("invalid-path", "Plugin path must not contain parent traversal");
  }
  if (parts.some((part) => part === "" || part === ".")) {
    return failure("invalid-path", "Plugin path has a malformed normalized form");
  }
  for (const part of parts) {
    if (part.includes(":")) {
      return failure("invalid-path", "Plugin path must not contain an alternate-data-stream or drive separator");
    }
    if (/[<>"|?*\u0001-\u001f]/.test(part)) {
      return failure("invalid-path", "Plugin path contains characters forbidden in portable Windows paths");
    }
    if (/[. ]$/.test(part)) {
      return failure("invalid-path", "Plugin path segments must not end in a dot or space");
    }
    if (WINDOWS_RESERVED_NAME.test(part)) {
      return failure("invalid-path", "Plugin path contains a reserved Windows device name");
    }
  }
  return { ok: true, value: parts.join(path.sep) };
}

function revalidateDirectoryRoot<T extends AuthorizedPluginRoot | ClaudeUserDirectory>(root: T): PluginPathResult<T> {
  let canonical: string;
  try {
    canonical = realpathNative(root.lexicalPath);
  } catch {
    return failure("unreadable-path", "Authorized plugin root is missing or unreadable", root.lexicalPath);
  }
  if (canonical !== root.canonicalPath || actualKind(canonical) !== "directory") {
    return failure("changed-path", "Authorized plugin root changed after validation", root.lexicalPath);
  }
  return { ok: true, value: root };
}

function isNativeFullyQualifiedAbsolute(value: string): boolean {
  if (process.platform === "win32") {
    if (/^[\\/]{2}[?.][\\/]/.test(value)) return false;
    if (/^[\\/]{1,2}(?:\?\?|GLOBALROOT)[\\/]/i.test(value)) return false;
    if (/^[A-Za-z]:[\\/]/.test(value)) return true;
    return /^\\\\[^\\/]+\\[^\\/]+(?:\\|$)/.test(value);
  }
  return value.startsWith("/") && !value.startsWith("//") && !value.startsWith("/\\");
}

export function authorizePluginRoot(rootPath: string): PluginPathResult<AuthorizedPluginRoot> {
  if (rootPath.length === 0 || rootPath.includes("\0") || !isNativeFullyQualifiedAbsolute(rootPath)) {
    return failure("invalid-path", "Installed plugin root must be a native fully-qualified absolute path", rootPath);
  }
  const lexicalPath = path.normalize(rootPath);
  let canonicalPath: string;
  try {
    canonicalPath = realpathNative(lexicalPath);
  } catch {
    return failure("unreadable-path", "Installed plugin root is missing or unreadable", lexicalPath);
  }
  if (actualKind(canonicalPath) !== "directory") {
    return failure("wrong-kind", "Installed plugin root is not a directory", lexicalPath);
  }
  return {
    ok: true,
    value: { lexicalPath, canonicalPath, [authorizedPluginRootBrand]: true },
  };
}

function authorizeClaudeUserDirectory(rootPath: string): PluginPathResult<ClaudeUserDirectory> {
  if (rootPath.length === 0 || rootPath.includes("\0") || !isNativeFullyQualifiedAbsolute(rootPath)) {
    return failure("invalid-path", "Claude user directory must be a native fully-qualified absolute path", rootPath);
  }
  const lexicalPath = path.normalize(rootPath);
  let canonicalPath: string;
  try {
    canonicalPath = realpathNative(lexicalPath);
  } catch {
    return failure("unreadable-path", "Claude user directory is missing or unreadable", lexicalPath);
  }
  if (actualKind(canonicalPath) !== "directory") {
    return failure("wrong-kind", "Claude user directory is not a directory", lexicalPath);
  }
  return {
    ok: true,
    value: { lexicalPath, canonicalPath, [claudeUserDirectoryBrand]: true },
  };
}

function validateExistingPath(
  root: AuthorizedPluginRoot,
  inputKind: PluginPathInputKind,
  declaredPath: string,
  relativePath: string,
  expectedKind: PluginPathKind,
): PluginPathResult<ValidatedPluginPath> {
  const rootResult = revalidateDirectoryRoot(root);
  if (!rootResult.ok) return rootResult;

  const lexicalPath = path.join(root.lexicalPath, relativePath);
  let canonicalPath: string;
  try {
    canonicalPath = realpathNative(lexicalPath);
  } catch {
    return failure("unreadable-path", "Plugin path is missing, unreadable, or a broken filesystem link", lexicalPath);
  }
  if (!isContained(root.canonicalPath, canonicalPath)) {
    return failure("path-escape", "Plugin path resolves outside the authorized plugin root", lexicalPath);
  }
  const kind = actualKind(canonicalPath);
  if (kind === undefined || (expectedKind !== "either" && kind !== expectedKind)) {
    return failure("wrong-kind", `Plugin path is not a ${expectedKind === "either" ? "regular file or directory" : expectedKind}`, lexicalPath);
  }
  return {
    ok: true,
    value: {
      root,
      inputKind,
      declaredPath,
      relativePath,
      lexicalPath,
      canonicalPath,
      kind,
      [validatedPluginPathBrand]: true,
    },
  };
}

export function resolvePluginPath(options: {
  root: AuthorizedPluginRoot;
  declaredPath: string;
  inputKind: PluginPathInputKind;
  kind: PluginPathKind;
}): PluginPathResult<ValidatedPluginPath> {
  const relative = validateRelativePath(options.declaredPath, options.inputKind);
  if (!relative.ok) return relative;
  return validateExistingPath(
    options.root,
    options.inputKind,
    options.declaredPath,
    relative.value,
    options.kind,
  );
}

// Close-to-use revalidation rejects changes visible during validation, including deterministic
// retargeting, but one replacement can still win the subsequent check/read race. This is not an OS sandbox.
export function revalidatePluginPath(source: ValidatedPluginPath): PluginPathResult<ValidatedPluginPath> {
  const current = validateExistingPath(
    source.root,
    source.inputKind,
    source.declaredPath,
    source.relativePath,
    source.kind,
  );
  if (!current.ok) return current;
  if (current.value.canonicalPath !== source.canonicalPath) {
    return failure("changed-path", "Plugin path target changed after validation", source.lexicalPath);
  }
  return current;
}

export function walkPluginFiles(options: {
  directory: ValidatedPluginPath;
  predicate?: (name: string, source: ValidatedPluginPath) => boolean;
  maxDepth?: number;
}): PluginWalkResult {
  const files: ValidatedPluginPath[] = [];
  const failures: PluginPathFailure[] = [];
  const result = (): PluginWalkResult => ({
    files,
    failures,
    diagnostics: failures.map((item) => item.diagnostic),
  });
  const start = revalidatePluginPath(options.directory);
  if (!start.ok) {
    failures.push(start);
    return result();
  }
  if (start.value.kind !== "directory") {
    failures.push(failure("wrong-kind", "Plugin walker requires a validated directory", start.value.lexicalPath));
    return result();
  }

  const seen = new Set<string>([start.value.canonicalPath]);
  const maxDepth = options.maxDepth ?? 12;
  if (!Number.isSafeInteger(maxDepth) || maxDepth < 0) {
    failures.push(failure("walk-failure", "Plugin walker maxDepth must be a non-negative safe integer", start.value.lexicalPath));
    return result();
  }
  const visit = (directory: ValidatedPluginPath, depth: number): void => {
    if (depth > maxDepth) {
      failures.push(failure(
        "walk-failure",
        `Plugin directory content was skipped because it exceeds maximum traversal depth ${maxDepth}`,
        directory.lexicalPath,
      ));
      return;
    }
    const currentDirectory = revalidatePluginPath(directory);
    if (!currentDirectory.ok) {
      failures.push(currentDirectory);
      return;
    }
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(currentDirectory.value.lexicalPath, { withFileTypes: true });
    } catch {
      failures.push(failure("walk-failure", "Plugin directory became unreadable while walking", directory.lexicalPath));
      return;
    }
    entries.sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
    for (const entry of entries) {
      const nativeRelativePath = path.join(directory.relativePath, entry.name);
      const declaredPath = nativeRelativePath.split(path.sep).join("/");
      const portable = validateRelativePath(declaredPath, "generated");
      if (!portable.ok || portable.value !== nativeRelativePath) {
        failures.push(portable.ok
          ? failure("invalid-path", "Discovered plugin path does not have an exact portable representation", path.join(directory.root.lexicalPath, nativeRelativePath))
          : { ...portable, diagnostic: { ...portable.diagnostic, source: path.join(directory.root.lexicalPath, nativeRelativePath) } });
        continue;
      }
      const validated = validateExistingPath(
        directory.root,
        "generated",
        declaredPath,
        nativeRelativePath,
        "either",
      );
      if (!validated.ok) {
        failures.push(validated);
        continue;
      }
      if (validated.value.kind === "directory") {
        if (seen.has(validated.value.canonicalPath)) {
          failures.push(failure("walk-failure", "Plugin directory link forms a traversal loop or duplicate target", validated.value.lexicalPath));
          continue;
        }
        seen.add(validated.value.canonicalPath);
        visit(validated.value, depth + 1);
      } else if (options.predicate?.(entry.name, validated.value) ?? true) {
        files.push(validated.value);
      }
    }
  };
  visit(start.value, 0);
  return result();
}

export function sanitizePluginDataKey(qualifiedIdentity: string): string {
  const readablePrefix = qualifiedIdentity.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 80);
  const digest = createHash("sha256").update(qualifiedIdentity, "utf8").digest("hex");
  return `${readablePrefix}--${digest}`;
}

function resolveProjectedPath(
  root: ClaudeUserDirectory,
  segments: readonly string[],
): PluginPathResult<{ lexicalPath: string; canonicalPath: string }> {
  let lexicalPath = root.lexicalPath;
  let canonicalPath = root.canonicalPath;
  let missing = false;
  for (const segment of segments) {
    lexicalPath = path.join(lexicalPath, segment);
    if (!missing) {
      try {
        fs.lstatSync(lexicalPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException | undefined)?.code !== "ENOENT") {
          return failure("unreadable-path", "Plugin data path component is unreadable", lexicalPath);
        }
        missing = true;
      }
      if (!missing) {
        try {
          canonicalPath = realpathNative(lexicalPath);
        } catch {
          return failure("unreadable-path", "Plugin data path contains a broken or unreadable filesystem link", lexicalPath);
        }
        if (!isContained(root.canonicalPath, canonicalPath)) {
          return failure("path-escape", "Plugin data path resolves outside its user directory", lexicalPath);
        }
        if (actualKind(canonicalPath) !== "directory") {
          return failure("wrong-kind", "Existing plugin data path component is not a directory", lexicalPath);
        }
        continue;
      }
    }
    canonicalPath = path.join(canonicalPath, segment);
  }
  return { ok: true, value: { lexicalPath, canonicalPath } };
}

export function resolvePluginDataLocation(
  userDirPath: string,
  qualifiedIdentity: string,
): PluginPathResult<PluginDataLocation> {
  if (!isQualifiedPluginId(qualifiedIdentity)) {
    return failure("invalid-path", "Plugin data location requires a valid qualified plugin identity");
  }
  const key = sanitizePluginDataKey(qualifiedIdentity);
  if (key.length === 0 || key.length > 255 || WINDOWS_RESERVED_NAME.test(key) || /[. ]$/.test(key)) {
    return failure("invalid-path", "Qualified plugin identity must produce a portable data key of at most 255 ASCII characters");
  }
  const userDir = authorizeClaudeUserDirectory(userDirPath);
  if (!userDir.ok) return userDir;
  const projected = resolveProjectedPath(userDir.value, ["plugins", "data", key]);
  if (!projected.ok) return projected;
  const baseProjected = resolveProjectedPath(userDir.value, ["plugins", "data"]);
  if (!baseProjected.ok) return baseProjected;
  if (!isContained(baseProjected.value.canonicalPath, projected.value.canonicalPath) || projected.value.canonicalPath === baseProjected.value.canonicalPath) {
    return failure("path-escape", "Generated plugin data location escapes its data base", projected.value.lexicalPath);
  }
  return {
    ok: true,
    value: {
      qualifiedIdentity,
      key,
      collisionToken: key.toLowerCase(),
      userDir: userDir.value,
      lexicalBasePath: baseProjected.value.lexicalPath,
      canonicalBasePath: baseProjected.value.canonicalPath,
      lexicalPath: projected.value.lexicalPath,
      canonicalPath: projected.value.canonicalPath,
      [pluginDataLocationBrand]: true,
    },
  };
}

export function authorizeOwnedPluginDataLocation(options: {
  profileRoot: string;
  dataRoot: string;
  profileKey: string;
  qualifiedIdentity: string;
}): PluginPathResult<OwnedPluginDataLocation> {
  if (!/^profile-[A-Za-z0-9_-]+$/.test(options.profileKey) || !isQualifiedPluginId(options.qualifiedIdentity)) {
    return failure("invalid-path", "Owned plugin data requires exact profile and qualified identities");
  }
  const profileRoot = authorizePluginRoot(options.profileRoot);
  if (!profileRoot.ok) return profileRoot;
  const lexicalBasePath = path.normalize(options.dataRoot);
  if (!isContained(profileRoot.value.lexicalPath, lexicalBasePath) || lexicalBasePath === profileRoot.value.lexicalPath) {
    return failure("path-escape", "Owned plugin data base escapes its profile root", lexicalBasePath);
  }
  const key = `plugin-${createHash("sha256").update(options.qualifiedIdentity, "utf8").digest("base64url")}`;
  const projectedBase = resolveOwnedProjectedPath(profileRoot.value, lexicalBasePath);
  if (!projectedBase.ok) return projectedBase;
  const lexicalPath = path.join(lexicalBasePath, key);
  const projected = resolveOwnedProjectedPath(profileRoot.value, lexicalPath);
  if (!projected.ok) return projected;
  if (!isContained(projectedBase.value.canonicalPath, projected.value.canonicalPath) || projected.value.canonicalPath === projectedBase.value.canonicalPath) {
    return failure("path-escape", "Owned plugin data identity escapes its data base", lexicalPath);
  }
  return { ok: true, value: {
    ownership: "picc-owned", qualifiedIdentity: options.qualifiedIdentity, profileKey: options.profileKey,
    profileRoot: profileRoot.value, lexicalBasePath, canonicalBasePath: projectedBase.value.canonicalPath,
    lexicalPath, canonicalPath: projected.value.canonicalPath, [ownedPluginDataLocationBrand]: true,
  } };
}

function resolveOwnedProjectedPath(root: AuthorizedPluginRoot, candidate: string): PluginPathResult<{ lexicalPath: string; canonicalPath: string }> {
  const rootCurrent = revalidateDirectoryRoot(root); if (!rootCurrent.ok) return rootCurrent;
  const relative = path.relative(root.lexicalPath, candidate);
  if (relative === "" || path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`)) return failure("path-escape", "Owned plugin data path escapes its profile root", candidate);
  let lexicalPath = root.lexicalPath; let canonicalPath = root.canonicalPath; let missing = false;
  for (const segment of relative.split(path.sep)) {
    lexicalPath = path.join(lexicalPath, segment);
    if (!missing) {
      try { fs.lstatSync(lexicalPath); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") return failure("unreadable-path", "Owned plugin data path is unreadable", lexicalPath); missing = true; }
      if (!missing) {
        try { canonicalPath = realpathNative(lexicalPath); } catch { return failure("unreadable-path", "Owned plugin data path is unreadable", lexicalPath); }
        if (!isContained(root.canonicalPath, canonicalPath) || actualKind(canonicalPath) !== "directory") return failure("path-escape", "Owned plugin data path changed or escaped", lexicalPath);
        continue;
      }
    }
    canonicalPath = path.join(canonicalPath, segment);
  }
  return { ok: true, value: { lexicalPath: candidate, canonicalPath } };
}

export function bindPluginRuntimeDataAuthorization(context: PluginRuntimeContext, authorization: AuthorizedPluginDataLocation): boolean {
  if (context.pluginId !== (authorization.ownership === "picc-owned" ? authorization.qualifiedIdentity : authorization.location.qualifiedIdentity)
    || path.resolve(context.dataDir) !== path.resolve(authorization.ownership === "picc-owned" ? authorization.lexicalPath : authorization.location.lexicalPath)) return false;
  runtimeDataAuthorities.set(context, authorization); return true;
}

export function pluginRuntimeDataAuthorization(context: PluginRuntimeContext): AuthorizedPluginDataLocation | undefined {
  return runtimeDataAuthorities.get(context);
}

export function prepareAuthorizedPluginDataLocation(authorization: AuthorizedPluginDataLocation): PluginPathResult<AuthorizedPluginDataLocation> {
  try {
    if (authorization.ownership === "claude-imported-readonly") {
      const current = revalidatePluginDataLocation(authorization.location); if (!current.ok) return current;
      fs.mkdirSync(current.value.lexicalPath, { recursive: true });
      const prepared = revalidatePluginDataLocation(current.value); return prepared.ok ? { ok: true, value: { ownership: "claude-imported-readonly", location: prepared.value } } : prepared;
    }
    if (authorization[ownedPluginDataLocationBrand] !== true) return failure("invalid-path", "Owned plugin data authority is not authentic");
    const current = authorizeOwnedPluginDataLocation({ profileRoot: authorization.profileRoot.lexicalPath, dataRoot: authorization.lexicalBasePath, profileKey: authorization.profileKey, qualifiedIdentity: authorization.qualifiedIdentity });
    if (!current.ok || current.value.profileRoot.canonicalPath !== authorization.profileRoot.canonicalPath || current.value.canonicalPath !== authorization.canonicalPath) return failure("changed-path", "Owned plugin data authority changed before use", authorization.lexicalPath);
    fs.mkdirSync(authorization.lexicalPath, { recursive: true });
    const prepared = authorizeOwnedPluginDataLocation({ profileRoot: authorization.profileRoot.lexicalPath, dataRoot: authorization.lexicalBasePath, profileKey: authorization.profileKey, qualifiedIdentity: authorization.qualifiedIdentity });
    return prepared.ok ? { ok: true, value: prepared.value } : prepared;
  } catch { return failure("unreadable-path", "Authorized plugin data directory could not be prepared"); }
}

export function ownedPluginDataDeletionEligible(pluginId: string, reference: CompleteOwnedProfileReference): boolean {
  return isQualifiedPluginId(pluginId) && isCompleteOwnedProfileReference(reference) && !reference.installations.some((item) => item.record.pluginId === pluginId);
}

export function createOwnedDataRetirementAuthorizer(inputs: {
  readonly store: OwnedStateStore;
  readonly qualifiedIdentity: string;
}): (context: OwnedDataRetirementMutationContext) => Promise<StoreResult<void>> {
  const store = inputs.store; const qualifiedIdentity = inputs.qualifiedIdentity;
  const deny = (): StoreResult<void> => ({ ok: false, code: "retirement-authority", message: "Exact owned data retirement transition authority is unavailable" });
  const canonical = (value: unknown): Buffer | undefined => { const encoded = canonicalJsonBytes(value); return encoded.ok ? Buffer.from(encoded.value) : undefined; };
  const observe = (candidate: string, expected: Buffer): "exact" | "absent" | "uncertain" => {
    try { return fs.readFileSync(candidate).equals(expected) ? "exact" : "uncertain"; }
    catch (error) { return (error as NodeJS.ErrnoException).code === "ENOENT" ? "absent" : "uncertain"; }
  };
  const sameInstallationAuthority = (left: OwnedPluginInstallationRecord, right: OwnedPluginInstallationRecord): boolean => {
    const rebound = { ...left, executableGenerationId: right.executableGenerationId }; const leftBytes = canonical(rebound); const rightBytes = canonical(right);
    return leftBytes !== undefined && rightBytes !== undefined && leftBytes.equals(rightBytes);
  };
  return async (context) => {
    const validStore = await revalidateOwnedStateStore(store); if (!validStore.ok) return validStore;
    if (!isAuthenticOwnedDataRetirementMutationContext(context) || !isQualifiedPluginId(qualifiedIdentity) || context.participant.profileKey !== store.profileKey
      || context.participant.qualifiedIdentity !== qualifiedIdentity || context.operationId.length === 0 || context.participants[context.participantIndex] !== context.participant) return deny();
    const successorIndex = context.participants.length - 1; const successor = context.participants[successorIndex];
    if (successorIndex <= context.participantIndex || successor === undefined || isOwnedDataRetirementParticipant(successor) || successor.targetClass !== "generation"
      || !samePath(successor.targetPath, path.join(store.generationsRoot, "current.json")) || successor.precondition.state !== "present" || successor.rollback.kind !== "restore-backup") return deny();
    const rawEvidence = context.participant.producerEvidence as OwnedDataRetirementProducerEvidence; const selectedPath = typeof rawEvidence === "object" && rawEvidence !== null ? rawEvidence.selectedRecordPath : undefined;
    const installationDeletes = context.participants.flatMap((participant, index) => !isOwnedDataRetirementParticipant(participant) && participant.kind === "plugin-installation-delete" ? [{ participant, index }] : []);
    const deleteIndexes = installationDeletes.flatMap(({ participant, index }) => participant.effect === "delete" && participant.targetClass === "owned"
      && typeof selectedPath === "string" && samePath(participant.targetPath, selectedPath) ? [index] : []);
    if (installationDeletes.length !== 1 || deleteIndexes.length !== 1 || deleteIndexes[0]! >= context.participantIndex) return deny();
    const deleteIndex = deleteIndexes[0]!; const deletion = context.participants[deleteIndex];
    if (deletion === undefined || isOwnedDataRetirementParticipant(deletion) || deletion.precondition.state !== "present" || deletion.rollback.kind !== "restore-backup"
      || deletion.precondition.digest !== deletion.rollback.digest) return deny();
    const reconstructed = reconstructOwnedDataRetirementProducerEvidence(store, context.participant.producerEvidence, {
      targetPath: deletion.targetPath, targetDigest: deletion.precondition.digest, backupPath: deletion.rollback.path, backupDigest: deletion.rollback.digest, scopeKey: deletion.scopeKey,
    });
    if (!reconstructed.ok || reconstructed.value.installation.pluginId !== qualifiedIdentity) return deny();
    const evidence = reconstructed.value.evidence; const predecessor = evidence.predecessorGeneration; const successorPayload = evidence.successorGeneration;
    const predecessorBytes = canonical(predecessor); const successorBytes = canonical(successorPayload);
    if (predecessor.generationId === successorPayload.generationId || predecessorBytes === undefined || successorBytes === undefined || successor.precondition.digest !== sha256(predecessorBytes)
      || successor.rollback.digest !== sha256(predecessorBytes) || successor.stagedDigest !== sha256(successorBytes) || successor.generationId !== successorPayload.generationId) return deny();
    try {
      const backup = fs.readFileSync(successor.rollback.path); if (!backup.equals(predecessorBytes)) return deny();
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT" || context.state !== "terminal") return deny(); }
    try {
      const staged = fs.readFileSync(successor.stagedPath); if (!staged.equals(successorBytes)) return deny();
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT" || context.state !== "terminal") return deny(); }
    const selectedMember = predecessor.members.filter((member) => member.pluginId === reconstructed.value.installation.pluginId && member.scope === reconstructed.value.installation.scope
      && member.checkoutFamilyKey === reconstructed.value.installation.checkoutFamilyKey && member.projectKey === reconstructed.value.installation.projectKey && member.recordDigest === reconstructed.value.recordDigest);
    if (selectedMember.length !== 1 || predecessor.members.filter((member) => member.pluginId === qualifiedIdentity).length !== 1
      || reconstructed.value.installation.executableGenerationId !== predecessor.generationId) return deny();
    const survivors = predecessor.members.filter((member) => member !== selectedMember[0]).map((member) => reconstructed.value.installations.find((item) => item.recordDigest === member.recordDigest
      && item.installation.pluginId === member.pluginId && item.installation.scope === member.scope && item.installation.checkoutFamilyKey === member.checkoutFamilyKey && item.installation.projectKey === member.projectKey)).filter((item): item is (typeof reconstructed.value.installations)[number] => item !== undefined);
    const replacementParticipants = context.participants.flatMap((participant, index) => !isOwnedDataRetirementParticipant(participant) && participant.kind === "plugin-installation-replace" ? [{ participant, index }] : []);
    if (replacementParticipants.length !== survivors.length || replacementParticipants.some(({ index }) => index <= deleteIndex || index >= context.participantIndex)) return deny();
    const replacements: Array<{ readonly index: number; readonly path: string; readonly predecessorBytes: Buffer; readonly successorBytes: Buffer; readonly successor: OwnedPluginInstallationRecord; readonly recordDigest: string }> = [];
    for (const survivor of survivors) {
      const matches = replacementParticipants.filter(({ participant }) => samePath(participant.targetPath, survivor.recordPath)); if (matches.length !== 1) return deny();
      const { participant, index } = matches[0]!;
      if (participant.effect === "delete" || participant.targetClass !== "owned" || participant.precondition.state !== "present" || participant.rollback.kind !== "restore-backup"
        || participant.precondition.digest !== survivor.recordBytesDigest || participant.rollback.digest !== survivor.recordBytesDigest) return deny();
      const persisted = participant.producerEvidence;
      if (typeof persisted !== "object" || persisted === null || Array.isArray(persisted) || Object.keys(persisted).sort().join() !== "predecessorEnvelopeBase64,role,successorEnvelopeBase64"
        || (persisted as { role?: unknown }).role !== "survivor-generation-rebind" || typeof (persisted as { predecessorEnvelopeBase64?: unknown }).predecessorEnvelopeBase64 !== "string"
        || typeof (persisted as { successorEnvelopeBase64?: unknown }).successorEnvelopeBase64 !== "string") return deny();
      const predecessorEnvelope = Buffer.from((persisted as { predecessorEnvelopeBase64: string }).predecessorEnvelopeBase64, "base64");
      const successorEnvelope = Buffer.from((persisted as { successorEnvelopeBase64: string }).successorEnvelopeBase64, "base64");
      if (!predecessorEnvelope.equals(survivor.recordBytes) || sha256(predecessorEnvelope) !== participant.precondition.digest || sha256(successorEnvelope) !== participant.stagedDigest) return deny();
      const decoded = readRecordEnvelope(successorEnvelope, reconstructed.value.registry);
      if (!decoded.ok || decoded.value.envelope.schema !== "plugin-installation" || decoded.value.envelope.ownerKey !== "picc-owned" || decoded.value.envelope.scopeKey !== participant.scopeKey) return deny();
      const replacement = decoded.value.decoded as OwnedPluginInstallationRecord;
      if (replacement.executableGenerationId !== successorPayload.generationId || !sameInstallationAuthority(survivor.installation, replacement)) return deny();
      replacements.push({ index, path: survivor.recordPath, predecessorBytes: survivor.recordBytes, successorBytes: successorEnvelope, successor: replacement, recordDigest: decoded.value.envelope.payloadDigest });
    }
    if (new Set(replacements.map((item) => item.index)).size !== replacements.length || replacements.some((item, index) => index > 0 && replacements[index - 1]!.index >= item.index)) return deny();
    const accounted = new Set([deleteIndex, context.participantIndex, successorIndex, ...replacements.map((item) => item.index)]);
    const profileRoot = path.resolve(store.profileRoot); const affectsOwnedCorpus = (candidate: string): boolean => isContained(profileRoot, path.resolve(candidate));
    for (const [index, participant] of context.participants.entries()) if (!accounted.has(index)) {
      if (index >= deleteIndex || isOwnedDataRetirementParticipant(participant) || participant.kind !== "plugin-settings"
        || participant.ownerKey !== "plugin-settings" || participant.targetClass !== "external" || participant.effect === "delete"
        || affectsOwnedCorpus(participant.targetPath)) return deny();
    }
    const expectedSuccessorMembers = predecessor.members.filter((member) => member !== selectedMember[0]).map((member) => {
      const replacement = replacements.find((item) => item.successor.pluginId === member.pluginId && item.successor.scope === member.scope
        && item.successor.checkoutFamilyKey === member.checkoutFamilyKey && item.successor.projectKey === member.projectKey);
      return replacement === undefined ? undefined : { ...member, recordDigest: replacement.recordDigest };
    });
    if (expectedSuccessorMembers.some((item) => item === undefined) || successorPayload.members.length !== expectedSuccessorMembers.length
      || !successorPayload.members.every((member, index) => canonical(member)?.equals(canonical(expectedSuccessorMembers[index]) ?? Buffer.alloc(0)) === true)) return deny();
    const terminalRollback = context.state === "terminal" && context.completed === 0 && context.rolledBack === context.participants.length;
    const effective = terminalRollback ? 0 : context.completed - context.rolledBack;
    if (effective < 0 || effective > context.participants.length || context.mutation === "rollback" && context.state !== "rolling-back" && !terminalRollback) return deny();
    if (effective === 0) {
      const fresh = readOwnedAdmissionRecords(store, reconstructed.value.registry, predecessor).completeReference;
      if (fresh === undefined || fresh.installations.length !== reconstructed.value.installations.length
        || !fresh.installations.every((installation) => { const admitted = getAdmittedInstallationEvidence(installation); return admitted !== undefined && reconstructed.value.installations.some((expected) => expected.recordDigest === installation.recordDigest
          && expected.recordBytesDigest === admitted.recordBytesDigest && samePath(expected.recordPath, admitted.recordPath) && canonical(expected.installation)?.equals(canonical(installation.record) ?? Buffer.alloc(0)) === true); })
        || fresh.installations.filter((installation) => installation.record.pluginId === qualifiedIdentity).length !== 1) return deny();
    }
    const selectedStatus = observe(deletion.targetPath, reconstructed.value.installations.find((item) => samePath(item.recordPath, deletion.targetPath))!.recordBytes);
    if (effective <= deleteIndex ? selectedStatus !== "exact" : selectedStatus !== "absent") return deny();
    for (const replacement of replacements) if (observe(replacement.path, effective <= replacement.index ? replacement.predecessorBytes : replacement.successorBytes) !== "exact") return deny();
    const expectedGeneration = effective > successorIndex ? successorBytes : predecessorBytes;
    if (observe(successor.targetPath, expectedGeneration) !== "exact") return deny();
    if (context.state === "terminal" && !terminalRollback && (context.completed !== context.participants.length || context.rolledBack !== 0)) return deny();
    return { ok: true, value: undefined };
  };
}

export function revalidatePluginDataLocation(
  location: PluginDataLocation,
): PluginPathResult<PluginDataLocation> {
  const current = resolvePluginDataLocation(location.userDir.lexicalPath, location.qualifiedIdentity);
  if (!current.ok) return current;
  if (
    current.value.userDir.canonicalPath !== location.userDir.canonicalPath ||
    current.value.canonicalBasePath !== location.canonicalBasePath ||
    current.value.canonicalPath !== location.canonicalPath
  ) {
    return failure("changed-path", "Plugin data location changed after validation", location.lexicalPath);
  }
  return current;
}

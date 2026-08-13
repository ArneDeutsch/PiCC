import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { defaultManagedPolicyDescription } from "../discovery/managed-policy.js";
import { projectIdentities } from "../util/project-identity.js";
import { canonicalJsonBytes, sha256, type StoreResult } from "./state-store.js";
import { PORTABLE_TREE_LIMITS } from "./tree-validator.js";

const MAX_HANDOFF_BYTES = 64 * 1024;
const MAX_FINGERPRINT_FILE_BYTES = 4 * 1024 * 1024;
const MAX_FINGERPRINTS = 96;
const MAX_IMPORTED_TREES = 64;
export const RELOAD_HANDOFF_RETENTION_MS = 24 * 60 * 60 * 1000;
export const RELOAD_ACTIVATION_UNCONFIRMED = "Activation is unconfirmed and this session cannot continue safely. Start a new PiCC session.";

export interface ReloadInputFingerprint {
  readonly key: string;
  readonly kind: "file" | "directory" | "tree";
  readonly status: "absent" | "present" | "unreadable" | "overflow";
  readonly digest?: `sha256:${string}`;
}

export interface ReloadCandidateBinding {
  readonly version: 1;
  readonly profileKey: string;
  readonly projectKey: `sha256:${string}`;
  readonly executableGeneration: ReloadInputFingerprint;
  readonly settings: readonly ReloadInputFingerprint[];
  readonly effectivePluginEnablement: `sha256:${string}`;
  readonly importedInstallations: ReloadInputFingerprint;
  readonly importedExecutableTrees: readonly ReloadInputFingerprint[];
  readonly digest: `sha256:${string}`;
}

export type ReloadHandoffOutcome = "pending" | "input-mismatch" | "operational-failure" | "restart-superseded";

export interface ReloadHandoffRecord {
  readonly format: "picc-plugin-reload-handoff";
  readonly version: 1;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly nonce: string;
  readonly binding: ReloadCandidateBinding;
  readonly outcome: ReloadHandoffOutcome;
}

export interface ReloadBindingCapture {
  readonly binding: ReloadCandidateBinding;
  readonly handoffPath: string;
  readonly recapture: () => StoreResult<ReloadCandidateBinding>;
}

export type ReloadAttemptOutcome = "armed" | "accepted" | "rejected";
interface ReloadAttemptState { nonce: string; outcome: ReloadAttemptOutcome }
interface ReloadAttemptRegistry { attempt?: ReloadAttemptState }
const RELOAD_ATTEMPT_SYMBOL = Symbol.for("@arnedeutsch/picc.plugin-reload-attempt.v1");

function attemptRegistry(): ReloadAttemptRegistry {
  const host = globalThis as typeof globalThis & Record<symbol, unknown>;
  const existing = host[RELOAD_ATTEMPT_SYMBOL];
  if (typeof existing === "object" && existing !== null) return existing as ReloadAttemptRegistry;
  const created: ReloadAttemptRegistry = Object.seal({ attempt: undefined });
  host[RELOAD_ATTEMPT_SYMBOL] = created;
  return created;
}

export function reserveReloadAttempt(): StoreResult<string> {
  const registry = attemptRegistry();
  if (registry.attempt !== undefined) return fail("attempt-active", "Another plugin reload attempt is already active");
  const nonce = randomBytes(18).toString("base64url");
  registry.attempt = { nonce, outcome: "armed" };
  return { ok: true, value: nonce };
}

export function armedReloadAttemptNonce(): string | undefined {
  const attempt = attemptRegistry().attempt;
  return attempt?.outcome === "armed" ? attempt.nonce : undefined;
}

export function resolveReloadAttempt(nonce: string, outcome: Exclude<ReloadAttemptOutcome, "armed">): boolean {
  const attempt = attemptRegistry().attempt;
  if (attempt?.nonce !== nonce || attempt.outcome !== "armed") return false;
  attempt.outcome = outcome;
  return true;
}

export function consumeReloadAttempt(nonce: string): ReloadAttemptOutcome | undefined {
  const registry = attemptRegistry();
  if (registry.attempt?.nonce !== nonce) return undefined;
  const outcome = registry.attempt.outcome;
  registry.attempt = undefined;
  return outcome;
}

function fail(code: string, message: string): StoreResult<never> {
  return { ok: false, code, message };
}

function samePath(left: string, right: string): boolean {
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function pathKey(candidate: string): string {
  return createHash("sha256").update(path.resolve(candidate), "utf8").digest("base64url");
}

function fingerprintFile(candidate: string): ReloadInputFingerprint {
  const key = pathKey(candidate);
  try {
    const resolved = path.resolve(candidate);
    const before = fs.lstatSync(resolved, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink() || before.size > BigInt(MAX_FINGERPRINT_FILE_BYTES)
      || !samePath(fs.realpathSync.native(resolved), resolved)) {
      return Object.freeze({ key, kind: "file", status: before.size > BigInt(MAX_FINGERPRINT_FILE_BYTES) ? "overflow" : "unreadable" });
    }
    const bytes = fs.readFileSync(resolved);
    const after = fs.lstatSync(resolved, { bigint: true });
    if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size
      || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs) {
      return Object.freeze({ key, kind: "file", status: "unreadable" });
    }
    return Object.freeze({ key, kind: "file", status: "present", digest: sha256(bytes) });
  } catch (error) {
    return Object.freeze({ key, kind: "file", status: (error as NodeJS.ErrnoException).code === "ENOENT" ? "absent" : "unreadable" });
  }
}

function fingerprintManagedDirectory(directory: string): { directory: ReloadInputFingerprint; files: string[] } {
  const key = pathKey(directory);
  try {
    const resolved = path.resolve(directory);
    const before = fs.lstatSync(resolved, { bigint: true });
    if (!before.isDirectory() || before.isSymbolicLink() || !samePath(fs.realpathSync.native(resolved), resolved)) {
      return { directory: Object.freeze({ key, kind: "directory", status: "unreadable" }), files: [] };
    }
    const names = fs.readdirSync(resolved).filter((name) => name.endsWith(".json")).sort();
    const after = fs.lstatSync(resolved, { bigint: true });
    if (names.length > 64 || after.dev !== before.dev || after.ino !== before.ino
      || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs) {
      return { directory: Object.freeze({ key, kind: "directory", status: names.length > 64 ? "overflow" : "unreadable" }), files: [] };
    }
    return {
      directory: Object.freeze({ key, kind: "directory", status: "present", digest: sha256(Buffer.from(JSON.stringify(names), "utf8")) }),
      files: names.map((name) => path.join(resolved, name)),
    };
  } catch (error) {
    return { directory: Object.freeze({ key, kind: "directory", status: (error as NodeJS.ErrnoException).code === "ENOENT" ? "absent" : "unreadable" }), files: [] };
  }
}

const WINDOWS_DEVICE_NAME = /^(?:con|prn|aux|nul|clock\$|conin\$|conout\$|com(?:[1-9]|[¹²³])|lpt(?:[1-9]|[¹²³]))(?:\..*)?$/iu;
const INVALID_PORTABLE_NAME = /[\\<>:"|?*]|[\p{Cc}\p{Cf}]/u;

function portableTreeSegment(name: string): boolean {
  return name.length > 0
    && name !== "."
    && name !== ".."
    && !/[. ]$/u.test(name)
    && !INVALID_PORTABLE_NAME.test(name)
    && !WINDOWS_DEVICE_NAME.test(name)
    && ![...name].some((character) => character.codePointAt(0)! >= 0xd800 && character.codePointAt(0)! <= 0xdfff);
}

function portableAliasKeys(relative: string): readonly string[] {
  const fold = (value: string): string => value.toLowerCase().toUpperCase().toLowerCase();
  return [fold(relative.normalize("NFC")), fold(relative.normalize("NFD"))];
}

function stableStat(before: fs.BigIntStats, after: fs.BigIntStats): boolean {
  return before.dev === after.dev && before.ino === after.ino && before.mode === after.mode
    && before.size === after.size && before.mtimeNs === after.mtimeNs && before.ctimeNs === after.ctimeNs;
}

function fingerprintImportedTree(candidate: string): ReloadInputFingerprint {
  const key = pathKey(candidate);
  const failed = (status: "unreadable" | "overflow" = "unreadable"): ReloadInputFingerprint =>
    Object.freeze({ key, kind: "tree", status });
  let overflow = false;
  try {
    const root = path.resolve(candidate);
    const rootStat = fs.lstatSync(root, { bigint: true });
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || !samePath(fs.realpathSync.native(root), root)) return failed();
    const identities = new Set<string>([`${rootStat.dev}:${rootStat.ino}`]);
    const aliases = new Map<string, string>();
    const digest = createHash("sha256");
    let entries = 0;
    let totalBytes = 0;

    const visit = (directory: string, relativeDirectory: string, depth: number): void => {
      const beforeDirectory = fs.lstatSync(directory, { bigint: true });
      if (!beforeDirectory.isDirectory() || beforeDirectory.isSymbolicLink()) throw new Error("not an ordinary directory");
      const names = fs.readdirSync(directory).sort((left, right) => Buffer.from(left).compare(Buffer.from(right)));
      for (const name of names) {
        if (!portableTreeSegment(name)) throw new Error("non-portable tree entry");
        const relative = relativeDirectory === "" ? name : `${relativeDirectory}/${name}`;
        entries += 1;
        if (entries > PORTABLE_TREE_LIMITS.maximumEntries
          || depth + 1 > PORTABLE_TREE_LIMITS.maximumDepth
          || Buffer.byteLength(relative, "utf8") > PORTABLE_TREE_LIMITS.maximumPathBytes) {
          overflow = true;
          throw new Error("tree bound exceeded");
        }
        for (const alias of portableAliasKeys(relative)) {
          const prior = aliases.get(alias);
          if (prior !== undefined && prior !== relative) throw new Error("tree alias collision");
          aliases.set(alias, relative);
        }
        const absolute = path.join(directory, name);
        const before = fs.lstatSync(absolute, { bigint: true });
        if (before.isSymbolicLink() || !samePath(fs.realpathSync.native(absolute), path.resolve(absolute))) throw new Error("aliased tree entry");
        const identity = `${before.dev}:${before.ino}`;
        if (identities.has(identity)) throw new Error("aliased tree identity");
        identities.add(identity);
        if (before.isDirectory()) {
          digest.update(`D\0${relative}\0`);
          visit(absolute, relative, depth + 1);
        } else if (before.isFile()) {
          if (before.nlink !== 1n) throw new Error("hard-linked tree file");
          if (before.size > BigInt(PORTABLE_TREE_LIMITS.maximumFileBytes)) {
            overflow = true;
            throw new Error("file bound exceeded");
          }
          totalBytes += Number(before.size);
          if (totalBytes > PORTABLE_TREE_LIMITS.maximumTotalBytes) {
            overflow = true;
            throw new Error("tree byte bound exceeded");
          }
          const bytes = fs.readFileSync(absolute);
          const after = fs.lstatSync(absolute, { bigint: true });
          if (after.nlink !== 1n || !stableStat(before, after)) throw new Error("unstable tree file");
          digest.update(`F\0${relative}\0${(before.mode & 0o111n) === 0n ? "0" : "1"}\0${sha256(bytes)}\0`);
        } else {
          throw new Error("special tree entry");
        }
      }
      const afterDirectory = fs.lstatSync(directory, { bigint: true });
      if (!stableStat(beforeDirectory, afterDirectory)) throw new Error("unstable tree directory");
    };

    digest.update("picc-imported-plugin-tree-v1\0");
    visit(root, "", 0);
    if (!stableStat(rootStat, fs.lstatSync(root, { bigint: true }))) return failed();
    return Object.freeze({ key, kind: "tree", status: "present", digest: `sha256:${digest.digest("hex")}` });
  } catch {
    return failed(overflow ? "overflow" : "unreadable");
  }
}

export function captureImportedExecutableTrees(roots: readonly string[]): StoreResult<readonly ReloadInputFingerprint[]> {
  if (roots.length > MAX_IMPORTED_TREES) {
    return fail("fingerprint-overflow", "Selected imported plugin trees exceed the bounded fingerprint limit");
  }
  return {
    ok: true,
    value: Object.freeze([...new Set(roots.map((root) => path.resolve(root)))]
      .map(fingerprintImportedTree)
      .sort((left, right) => left.key.localeCompare(right.key))),
  };
}

export function sameImportedExecutableTrees(
  left: readonly ReloadInputFingerprint[],
  right: readonly ReloadInputFingerprint[],
): boolean {
  return left.length === right.length && left.every((item, index) => {
    const other = right[index];
    return other !== undefined && item.key === other.key && item.kind === other.kind
      && item.status === other.status && item.digest === other.digest;
  });
}

function ordinarySettingsPaths(cwd: string, projectRoot: string, userDir: string): string[] {
  const result = [path.join(userDir, "settings.json")];
  const relative = path.relative(projectRoot, cwd);
  const segments = relative === "" ? [] : relative.split(path.sep).filter(Boolean);
  for (let index = 0; index <= segments.length; index++) {
    const directory = path.join(projectRoot, ...segments.slice(0, index));
    result.push(path.join(directory, ".claude", "settings.json"));
    result.push(path.join(directory, ".claude", "settings.local.json"));
  }
  const identities = projectIdentities(projectRoot);
  if (identities.length > 1) result.push(path.join(identities[0]!, ".claude", "settings.local.json"));
  return [...new Set(result.map((item) => path.resolve(item)))];
}

function withDigest(unsigned: Omit<ReloadCandidateBinding, "digest">): StoreResult<ReloadCandidateBinding> {
  const bytes = canonicalJsonBytes(unsigned, MAX_HANDOFF_BYTES);
  return bytes.ok
    ? { ok: true, value: Object.freeze({ ...unsigned, digest: sha256(bytes.value) }) }
    : fail(bytes.code, "Reload candidate fingerprints exceed the bounded handoff limit");
}

export function captureReloadCandidateBinding(options: {
  cwd: string;
  projectRoot: string;
  userDir: string;
  profileRoot: string;
  profileKey: string;
  generationPath: string;
  expectedGeneration?: Readonly<{ status: "absent" | "present"; digest?: `sha256:${string}` }>;
  effectivePluginEnablement: `sha256:${string}`;
  importedExecutableRoots: readonly string[];
  initialImportedExecutableTrees: readonly ReloadInputFingerprint[];
  managedSettingsPaths?: readonly string[];
  managedPolicyPlatform?: NodeJS.Platform;
}): StoreResult<ReloadBindingCapture> {
  const canonicalRootKeys = [...new Set(options.importedExecutableRoots.map((root) => path.resolve(root)))]
    .map(pathKey)
    .sort((left, right) => left.localeCompare(right));
  const initialImportedExecutableTrees = Object.freeze(options.initialImportedExecutableTrees.map((fingerprint) => Object.freeze({
    key: fingerprint.key,
    kind: fingerprint.kind,
    status: fingerprint.status,
    ...(fingerprint.digest === undefined ? {} : { digest: fingerprint.digest }),
  })));
  if (initialImportedExecutableTrees.length !== canonicalRootKeys.length
    || initialImportedExecutableTrees.some((fingerprint, index) => fingerprint.kind !== "tree" || fingerprint.key !== canonicalRootKeys[index])) {
    return fail("imported-root-mismatch", "Initial imported fingerprints do not match the selected plugin roots");
  }

  const capture = (importedExecutableTrees: readonly ReloadInputFingerprint[]): StoreResult<ReloadCandidateBinding> => {
    const settings: ReloadInputFingerprint[] = ordinarySettingsPaths(options.cwd, options.projectRoot, options.userDir).map(fingerprintFile);
    if (options.managedSettingsPaths !== undefined) {
      settings.push(...options.managedSettingsPaths.map(fingerprintFile));
    } else {
      const managed = defaultManagedPolicyDescription(options.managedPolicyPlatform ?? process.platform);
      settings.push(fingerprintFile(managed.systemSettingsPath));
      const dropIns = fingerprintManagedDirectory(managed.dropInDir);
      settings.push(dropIns.directory, ...dropIns.files.map(fingerprintFile));
    }
    if (settings.length > MAX_FINGERPRINTS) return fail("fingerprint-overflow", "Reload settings authority exceeds the bounded fingerprint limit");
    settings.sort((left, right) => left.key.localeCompare(right.key) || left.kind.localeCompare(right.kind));
    const executableGeneration = fingerprintFile(options.generationPath);
    if (options.expectedGeneration !== undefined
      && (executableGeneration.status !== options.expectedGeneration.status
        || executableGeneration.digest !== options.expectedGeneration.digest)) {
      return fail("generation-race", "Executable admission generation changed during candidate assembly");
    }
    const unsigned = Object.freeze({
      version: 1 as const,
      profileKey: options.profileKey,
      projectKey: sha256(Buffer.from(path.resolve(options.projectRoot), "utf8")),
      executableGeneration,
      settings: Object.freeze(settings),
      effectivePluginEnablement: options.effectivePluginEnablement,
      importedInstallations: fingerprintFile(path.join(options.userDir, "plugins", "installed_plugins.json")),
      importedExecutableTrees,
    });
    return withDigest(unsigned);
  };
  const binding = capture(initialImportedExecutableTrees);
  if (!binding.ok) return binding;
  const recapture = (): StoreResult<ReloadCandidateBinding> => {
    const importedExecutableTrees = captureImportedExecutableTrees(options.importedExecutableRoots);
    return importedExecutableTrees.ok ? capture(importedExecutableTrees.value) : importedExecutableTrees;
  };
  return {
    ok: true,
    value: Object.freeze({
      binding: binding.value,
      handoffPath: path.join(options.profileRoot, "generations", "reload-handoff.json"),
      recapture,
    }),
  };
}

function validBinding(value: unknown): value is ReloadCandidateBinding {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const item = value as Partial<ReloadCandidateBinding>;
  if (item.version !== 1 || typeof item.profileKey !== "string" || typeof item.projectKey !== "string"
    || typeof item.digest !== "string" || typeof item.effectivePluginEnablement !== "string"
    || !Array.isArray(item.settings) || item.settings.length > MAX_FINGERPRINTS
    || !Array.isArray(item.importedExecutableTrees) || item.importedExecutableTrees.length > MAX_IMPORTED_TREES
    || item.executableGeneration === undefined || item.importedInstallations === undefined) return false;
  const { digest, ...unsigned } = item;
  const rebuilt = withDigest(unsigned as Omit<ReloadCandidateBinding, "digest">);
  return rebuilt.ok && rebuilt.value.digest === digest;
}

function decodeRecord(bytes: Buffer, now: number): StoreResult<ReloadHandoffRecord | undefined> {
  if (bytes.byteLength > MAX_HANDOFF_BYTES) return fail("handoff-overflow", "Reload handoff exceeds its bounded limit");
  try {
    const value = JSON.parse(bytes.toString("utf8")) as Partial<ReloadHandoffRecord>;
    if (value.format !== "picc-plugin-reload-handoff" || value.version !== 1 || !Number.isSafeInteger(value.createdAt)
      || !Number.isSafeInteger(value.expiresAt) || value.expiresAt! - value.createdAt! !== RELOAD_HANDOFF_RETENTION_MS
      || typeof value.nonce !== "string" || !/^[A-Za-z0-9_-]{16,64}$/.test(value.nonce)
      || !["pending", "input-mismatch", "operational-failure", "restart-superseded"].includes(String(value.outcome))
      || !validBinding(value.binding)) return fail("invalid-handoff", "Reload handoff is invalid");
    if (value.expiresAt! < now) return { ok: true, value: undefined };
    return { ok: true, value: Object.freeze(value as ReloadHandoffRecord) };
  } catch {
    return fail("invalid-handoff", "Reload handoff is invalid");
  }
}

export function readReloadHandoff(handoffPath: string, now = Date.now()): StoreResult<ReloadHandoffRecord | undefined> {
  try { return decodeRecord(fs.readFileSync(handoffPath), now); }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ENOENT" ? { ok: true, value: undefined } : fail("unreadable-handoff", "Reload handoff could not be read"); }
}

function atomicWrite(target: string, bytes: Uint8Array): StoreResult<void> {
  const parent = path.dirname(target);
  const temporary = path.join(parent, `.reload-handoff-${process.pid}-${randomBytes(8).toString("hex")}.tmp`);
  try {
    fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") fs.chmodSync(parent, 0o700);
    if (!samePath(fs.realpathSync.native(parent), path.resolve(parent))) return fail("unsafe-handoff", "Reload handoff parent is not canonical");
    const descriptor = fs.openSync(temporary, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
    try { fs.writeFileSync(descriptor, bytes); fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
    fs.renameSync(temporary, target);
    return { ok: true, value: undefined };
  } catch {
    try { fs.rmSync(temporary, { force: true }); } catch { /* primary failure is authoritative */ }
    return fail("handoff-write", "Reload handoff could not be written atomically");
  }
}

export function writeReloadHandoff(handoffPath: string, binding: ReloadCandidateBinding, nonce: string, now = Date.now()): StoreResult<ReloadHandoffRecord> {
  if (!validBinding(binding)) return fail("invalid-binding", "Reload candidate binding is invalid");
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(nonce)) return fail("invalid-nonce", "Reload attempt nonce is invalid");
  const record: ReloadHandoffRecord = Object.freeze({
    format: "picc-plugin-reload-handoff",
    version: 1,
    createdAt: now,
    expiresAt: now + RELOAD_HANDOFF_RETENTION_MS,
    nonce,
    binding,
    outcome: "pending",
  });
  const bytes = canonicalJsonBytes(record, MAX_HANDOFF_BYTES);
  if (!bytes.ok) return fail(bytes.code, bytes.message);
  const written = atomicWrite(handoffPath, bytes.value);
  return written.ok ? { ok: true, value: record } : written;
}

export function recordReloadHandoffOutcome(handoffPath: string, record: ReloadHandoffRecord, outcome: Exclude<ReloadHandoffOutcome, "pending">): StoreResult<void> {
  const bytes = canonicalJsonBytes(Object.freeze({ ...record, outcome }), MAX_HANDOFF_BYTES);
  return bytes.ok ? atomicWrite(handoffPath, bytes.value) : fail(bytes.code, bytes.message);
}

export function clearReloadHandoff(handoffPath: string): StoreResult<void> {
  try { fs.rmSync(handoffPath, { force: true }); return { ok: true, value: undefined }; }
  catch { return fail("handoff-clear", "Reload handoff could not be cleared"); }
}

export function sameReloadBinding(left: ReloadCandidateBinding, right: ReloadCandidateBinding): boolean {
  return left.digest === right.digest && left.profileKey === right.profileKey && left.projectKey === right.projectKey;
}

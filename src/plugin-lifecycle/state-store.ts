import { createHash, randomBytes } from "node:crypto";
import { constants, promises as fs, type BigIntStats } from "node:fs";
import path from "node:path";
import { digestArtifactEntries, type ArtifactDigestEntry } from "./artifact-digest.js";
import { OwnedStateStoreNamespace, type LifecycleLocations } from "./locations.js";
import {
  bindPrivateStagingParentForTrustedCode,
  type MaterializedPluginTree,
  type PrivateStagingParent,
} from "./tree-materializer.js";
import { PLUGIN_LIFECYCLE_LIMITS, type Sha256 } from "./types.js";

export const STORE_FORMAT_VERSION = 1;
export const STORE_LIMITS = Object.freeze({
  maximumEnvelopeBytes: PLUGIN_LIFECYCLE_LIMITS.maximumDocumentBytes,
  maximumOperationIdBytes: 128,
  maximumSchemaBytes: 128,
});

export type StoreResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly code: string; readonly message: string };

function failure(code: string, message: string): StoreResult<never> {
  return { ok: false, code, message };
}

interface FileIdentity { readonly dev: bigint; readonly ino: bigint }
interface BoundPath { readonly path: string; readonly identity: FileIdentity }

export interface OwnedStateStore {
  /** The authoritative PiCC-owned store root for this profile; this store shares no mutable state across profiles. */
  readonly root: string;
  readonly profileRoot: string;
  readonly profileKey: string;
  readonly artifactsRoot: string;
  readonly recordsRoot: string;
  readonly stagingRoot: string;
  readonly generationsRoot: string;
  readonly journalsRoot: string;
  readonly receiptsRoot: string;
  readonly locksRoot: string;
  readonly quarantineRoot: string;
  readonly dataRoot: string;
}

interface StoreAuthority {
  readonly paths: readonly BoundPath[];
  readonly store: OwnedStateStore;
}

const authorities = new WeakMap<OwnedStateStore, StoreAuthority>();

function identity(stat: BigIntStats): FileIdentity {
  return { dev: stat.dev, ino: stat.ino };
}

function sameIdentity(expected: FileIdentity, actual: BigIntStats): boolean {
  return expected.dev === actual.dev && expected.ino === actual.ino;
}

function equalPath(left: string, right: string): boolean {
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function isWindowsNamespaceOrUnc(value: string): boolean {
  return process.platform === "win32" && (/^[\\/]{2}/.test(value) || /^[\\/]{2}[?.][\\/]/.test(value));
}

export function isContainedPath(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

async function ordinaryDirectory(candidate: string): Promise<BigIntStats> {
  const stat = await fs.lstat(candidate, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("not an ordinary directory");
  return stat;
}

async function verifyOwnedDirectory(candidate: string, requirePrivate: boolean): Promise<BigIntStats> {
  const stat = await ordinaryDirectory(candidate);
  if (typeof process.getuid === "function" && stat.uid !== BigInt(process.getuid())) throw new Error("directory owner differs");
  if (process.platform !== "win32" && requirePrivate && (stat.mode & 0o077n) !== 0n) throw new Error("directory is not private");
  return stat;
}

async function createPrivateDirectory(candidate: string): Promise<void> {
  await fs.mkdir(candidate, { mode: 0o700 });
  if (process.platform !== "win32") await fs.chmod(candidate, 0o700);
}

const STORE_DIRECTORIES = [
  "artifacts", "artifacts/sha256", "records", "staging", "generations", "journals", "receipts", "locks", "quarantine", "data",
] as const;

async function syncDirectory(directory: string): Promise<void> {
  // Windows does not expose directory handles through Node on all supported filesystems.
  // File payloads are still fsynced; unsupported directory-handle errors are the documented
  // platform exception rather than making every Windows lifecycle operation impossible.
  try {
    const handle = await fs.open(directory, constants.O_RDONLY);
    try { await handle.sync(); } finally { await handle.close(); }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (process.platform !== "win32" || (code !== "EPERM" && code !== "EACCES" && code !== "EBADF")) throw error;
  }
}

export async function establishOwnedStateStore(
  locations: LifecycleLocations,
  trustedHome: string,
): Promise<StoreResult<OwnedStateStore>> {
  try {
    if (typeof trustedHome !== "string" || trustedHome.length === 0 || !path.isAbsolute(trustedHome)
      || isWindowsNamespaceOrUnc(trustedHome) || isWindowsNamespaceOrUnc(locations.root)) throw new Error("invalid trusted home");
    const home = path.resolve(trustedHome);
    const root = path.resolve(locations.root);
    const namespaceDirectory = locations.storeNamespace === OwnedStateStoreNamespace.Plugins
      ? "plugins"
      : locations.storeNamespace === OwnedStateStoreNamespace.Mcp
        ? "mcp"
        : undefined;
    if (namespaceDirectory === undefined) throw new Error("invalid store namespace");
    const expectedRoot = path.join(home, ".picc", namespaceDirectory, "v1");
    const expectedProfileRoot = path.join(expectedRoot, "profiles", locations.profileKey);
    if (!/^profile-[A-Za-z0-9_-]+$/.test(locations.profileKey) || !equalPath(root, expectedRoot)
      || !equalPath(path.resolve(locations.profileRoot), expectedProfileRoot)
      || !equalPath(path.resolve(locations.dataRoot), path.join(expectedProfileRoot, "data"))
      || !isContainedPath(home, root) || equalPath(home, root)) throw new Error("store is outside the trusted home");
    const homeReal = await fs.realpath(home);
    if (!equalPath(homeReal, home)) throw new Error("trusted home is aliased");
    await verifyOwnedDirectory(home, false);

    const profileRoot = path.resolve(locations.profileRoot);
    const relative = path.relative(home, profileRoot).split(path.sep).filter(Boolean);
    let current = home;
    const bound: BoundPath[] = [];
    for (const segment of relative) {
      current = path.join(current, segment);
      try { await createPrivateDirectory(current); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      const stat = await verifyOwnedDirectory(current, true);
      if (!equalPath(await fs.realpath(current), current)) throw new Error("store component is aliased");
      bound.push({ path: current, identity: identity(stat) });
    }
    for (const relativeDirectory of STORE_DIRECTORIES) {
      const directory = path.join(profileRoot, ...relativeDirectory.split("/"));
      try { await createPrivateDirectory(directory); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      const stat = await verifyOwnedDirectory(directory, true);
      if (!equalPath(await fs.realpath(directory), directory)) throw new Error("store directory is aliased");
      bound.push({ path: directory, identity: identity(stat) });
    }

    const store = Object.freeze({
      root: profileRoot,
      profileRoot,
      profileKey: locations.profileKey,
      artifactsRoot: path.join(profileRoot, "artifacts", "sha256"),
      recordsRoot: path.join(profileRoot, "records"),
      stagingRoot: path.join(profileRoot, "staging"),
      generationsRoot: path.join(profileRoot, "generations"),
      journalsRoot: path.join(profileRoot, "journals"),
      receiptsRoot: path.join(profileRoot, "receipts"),
      locksRoot: path.join(profileRoot, "locks"),
      quarantineRoot: path.join(profileRoot, "quarantine"),
      dataRoot: path.join(profileRoot, "data"),
    });
    const dataIdentity = await ordinaryDirectory(store.dataRoot);
    const quarantineIdentity = await ordinaryDirectory(store.quarantineRoot);
    if (dataIdentity.dev !== quarantineIdentity.dev) throw new Error("data and quarantine are on different filesystems");
    authorities.set(store, { paths: Object.freeze(bound), store });
    return { ok: true, value: store };
  } catch {
    return failure("unsafe-store", "Canonical owned state store could not be established beneath the trusted user home");
  }
}

export async function revalidateOwnedStateStore(store: OwnedStateStore): Promise<StoreResult<void>> {
  const authority = authorities.get(store);
  if (authority === undefined) return failure("untrusted-store", "Store capability was not issued by canonical establishment");
  try {
    for (const component of authority.paths) {
      const stat = await verifyOwnedDirectory(component.path, !equalPath(component.path, path.parse(component.path).root));
      if (!sameIdentity(component.identity, stat) || !equalPath(await fs.realpath(component.path), component.path)) throw new Error("identity changed");
    }
    return { ok: true, value: undefined };
  } catch {
    return failure("changed-store", "Canonical owned state store identity or privacy evidence changed");
  }
}

export async function issuePrivateStagingParent(store: OwnedStateStore): Promise<StoreResult<PrivateStagingParent>> {
  const valid = await revalidateOwnedStateStore(store);
  if (!valid.ok) return valid;
  const bound = await bindPrivateStagingParentForTrustedCode(store.stagingRoot);
  return bound.ok ? { ok: true, value: bound.value } : failure("unsafe-store", bound.error.message);
}

function canonicalize(value: unknown, depth = 0): unknown {
  if (depth > PLUGIN_LIFECYCLE_LIMITS.maximumNesting) throw new Error("nesting limit");
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (value.length > PLUGIN_LIFECYCLE_LIMITS.maximumStringLength) throw new Error("string limit");
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) {
    if (value.length > PLUGIN_LIFECYCLE_LIMITS.maximumArrayItems) throw new Error("array limit");
    return value.map((item) => canonicalize(item, depth + 1));
  }
  if (typeof value === "object" && value !== null && Object.getPrototypeOf(value) === Object.prototype) {
    const entries = Object.entries(value);
    if (entries.length > PLUGIN_LIFECYCLE_LIMITS.maximumObjectKeys) throw new Error("object limit");
    const result: Record<string, unknown> = {};
    for (const [key, item] of entries.sort(([a], [b]) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
      if (key.length > PLUGIN_LIFECYCLE_LIMITS.maximumKeyLength || item === undefined) throw new Error("key/value limit");
      result[key] = canonicalize(item, depth + 1);
    }
    return result;
  }
  throw new Error("non-canonical value");
}

export function canonicalJsonBytes(value: unknown, maximumBytes = STORE_LIMITS.maximumEnvelopeBytes): StoreResult<Uint8Array> {
  try {
    const bytes = Buffer.from(JSON.stringify(canonicalize(value)), "utf8");
    if (bytes.byteLength > maximumBytes) return failure("bounded-data", "Canonical payload exceeds its byte limit");
    return { ok: true, value: bytes };
  } catch {
    return failure("invalid-data", "Value cannot be represented as bounded canonical JSON");
  }
}

export function sha256(bytes: Uint8Array): Sha256 {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

export interface ProducerCodec<T> {
  readonly schema: string;
  readonly version: number;
  readonly decode: (payload: unknown) => StoreResult<T>;
}

export interface ProducerCodecRegistry {
  readonly lookup: (schema: string, version: number) => ProducerCodec<unknown> | undefined;
}

export function createProducerCodecRegistry(codecs: readonly ProducerCodec<unknown>[]): StoreResult<ProducerCodecRegistry> {
  const map = new Map<string, ProducerCodec<unknown>>();
  for (const codec of codecs) {
    if (!/^[a-z][a-z0-9.-]{0,127}$/.test(codec.schema) || !Number.isSafeInteger(codec.version) || codec.version < 1) {
      return failure("invalid-codec", "Trusted producer codec has an invalid identity");
    }
    const key = `${codec.schema}\0${codec.version}`;
    if (map.has(key)) return failure("invalid-codec", "Trusted producer codec identity is duplicated");
    map.set(key, Object.freeze(codec));
  }
  return { ok: true, value: Object.freeze({
    lookup: (schema: string, version: number): ProducerCodec<unknown> | undefined => map.get(`${schema}\0${version}`),
  }) };
}

export function ownedRecordPartition(store: OwnedStateStore, ownerKey: string, scopeKey: string): StoreResult<string> {
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(ownerKey) || !/^[A-Za-z0-9._-]{1,256}$/.test(scopeKey)) {
    return failure("invalid-owner", "Record owner or scope key is invalid");
  }
  const owner = createHash("sha256").update(ownerKey, "utf8").digest("base64url");
  const scope = createHash("sha256").update(scopeKey, "utf8").digest("base64url");
  return { ok: true, value: path.join(store.recordsRoot, `owner-${owner}`, `scope-${scope}`) };
}

export interface RecordEnvelope {
  readonly format: "picc-owned-record";
  readonly formatVersion: 1;
  readonly schema: string;
  readonly codecVersion: number;
  readonly ownerKey: string;
  readonly scopeKey: string;
  readonly payload: unknown;
  readonly payloadDigest: Sha256;
}

export function createRecordEnvelope<T>(
  codec: ProducerCodec<T>, ownerKey: string, scopeKey: string, payload: T,
): StoreResult<{ readonly envelope: RecordEnvelope; readonly bytes: Uint8Array }> {
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(ownerKey) || !/^[A-Za-z0-9._-]{1,256}$/.test(scopeKey)) {
    return failure("invalid-owner", "Record owner or scope key is invalid");
  }
  const validated = codec.decode(payload);
  if (!validated.ok) return failure("invalid-payload", "Producer payload failed close-to-write validation");
  const payloadBytes = canonicalJsonBytes(payload);
  if (!payloadBytes.ok) return payloadBytes;
  const envelope: RecordEnvelope = Object.freeze({
    format: "picc-owned-record", formatVersion: 1, schema: codec.schema, codecVersion: codec.version,
    ownerKey, scopeKey, payload, payloadDigest: sha256(payloadBytes.value),
  });
  const bytes = canonicalJsonBytes(envelope);
  return bytes.ok ? { ok: true, value: { envelope, bytes: bytes.value } } : bytes;
}

export function readRecordEnvelope(
  bytes: Uint8Array, registry: ProducerCodecRegistry,
): StoreResult<{ readonly envelope: RecordEnvelope; readonly payloadBytes: Uint8Array; readonly decoded: unknown }> {
  if (bytes.byteLength > STORE_LIMITS.maximumEnvelopeBytes) return failure("bounded-data", "Record envelope exceeds its byte limit");
  try {
    const parsed = JSON.parse(Buffer.from(bytes).toString("utf8")) as Record<string, unknown>;
    const canonical = canonicalJsonBytes(parsed);
    if (!canonical.ok || !Buffer.from(canonical.value).equals(Buffer.from(bytes))) throw new Error("not canonical");
    const keys = Object.keys(parsed).sort();
    const expectedKeys = ["codecVersion", "format", "formatVersion", "ownerKey", "payload", "payloadDigest", "schema", "scopeKey"];
    if (keys.length !== expectedKeys.length || !keys.every((key, index) => key === expectedKeys[index])
      || parsed.format !== "picc-owned-record" || parsed.formatVersion !== 1 || typeof parsed.schema !== "string"
      || !/^[a-z][a-z0-9.-]{0,127}$/.test(parsed.schema) || typeof parsed.codecVersion !== "number"
      || !Number.isSafeInteger(parsed.codecVersion) || parsed.codecVersion < 1
      || typeof parsed.ownerKey !== "string" || !/^[A-Za-z0-9._-]{1,128}$/.test(parsed.ownerKey)
      || typeof parsed.scopeKey !== "string" || !/^[A-Za-z0-9._-]{1,256}$/.test(parsed.scopeKey)
      || typeof parsed.payloadDigest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(parsed.payloadDigest)) throw new Error("invalid envelope");
    const codec = registry.lookup(parsed.schema, parsed.codecVersion);
    if (codec === undefined) return failure("unknown-producer", "Record producer schema or version is unavailable; record is read-only");
    const payloadBytes = canonicalJsonBytes(parsed.payload);
    if (!payloadBytes.ok || sha256(payloadBytes.value) !== parsed.payloadDigest) throw new Error("payload digest");
    const decoded = codec.decode(parsed.payload);
    if (!decoded.ok) return failure("invalid-payload", "Persisted producer payload is invalid and read-only");
    return { ok: true, value: { envelope: parsed as unknown as RecordEnvelope, payloadBytes: payloadBytes.value, decoded: decoded.value } };
  } catch {
    return failure("invalid-envelope", "Record envelope is invalid and read-only");
  }
}

export async function writeFileAtomic(target: string, bytes: Uint8Array): Promise<void> {
  const temporary = `${target}.tmp-${process.pid}-${randomBytes(8).toString("hex")}`;
  const handle = await fs.open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
  try { await fs.rename(temporary, target); await syncDirectory(path.dirname(target)); }
  catch (error) { await fs.rm(temporary, { force: true }).catch(() => undefined); throw error; }
}

async function artifactEntries(root: string): Promise<readonly ArtifactDigestEntry[]> {
  const entries: ArtifactDigestEntry[] = [];
  async function walk(directory: string, relative: string): Promise<void> {
    for (const name of (await fs.readdir(directory)).sort()) {
      const child = path.join(directory, name);
      const childRelative = relative === "" ? name : `${relative}/${name}`;
      const stat = await fs.lstat(child, { bigint: true });
      if (stat.isSymbolicLink()) throw new Error("artifact alias");
      if (stat.isDirectory()) { entries.push({ path: childRelative, kind: "directory" }); await walk(child, childRelative); }
      else if (stat.isFile() && stat.nlink === 1n) entries.push({ path: childRelative, kind: "file", executable: process.platform !== "win32" && (stat.mode & 0o111n) !== 0n, data: await fs.readFile(child) });
      else throw new Error("artifact special entry");
    }
  }
  await walk(root, "");
  return entries;
}

export async function verifyArtifact(directory: string, expected: Sha256): Promise<boolean> {
  try { return digestArtifactEntries(await artifactEntries(directory)) === expected; } catch { return false; }
}

export type ArtifactPublicationFaultPhase = "before-claim" | "after-claim" | "before-publication" | "after-publication" | "before-claim-cleanup" | "after-claim-cleanup";
export interface ArtifactPublicationFaultSeam { readonly hit: (phase: ArtifactPublicationFaultPhase) => void | Promise<void> }
const NO_ARTIFACT_FAULTS: ArtifactPublicationFaultSeam = Object.freeze({ hit: () => undefined });

export async function publishMaterializedArtifact(
  store: OwnedStateStore,
  materialized: MaterializedPluginTree,
  faults: ArtifactPublicationFaultSeam = NO_ARTIFACT_FAULTS,
): Promise<StoreResult<{ readonly digest: Sha256; readonly path: string; readonly reused: boolean }>> {
  const valid = await revalidateOwnedStateStore(store);
  if (!valid.ok) return valid;
  const source = path.resolve(materialized.stagingDirectory);
  if (!isContainedPath(store.stagingRoot, source) || equalPath(source, store.stagingRoot)) return failure("untrusted-staging", "Artifact staging directory is outside the canonical store");
  try {
    const sourceStat = await ordinaryDirectory(source);
    if (!equalPath(await fs.realpath(source), source) || !sameIdentity(identity(sourceStat), await ordinaryDirectory(source))) throw new Error("aliased staging");
  } catch { return failure("untrusted-staging", "Artifact staging identity or canonical containment changed"); }
  if (!await verifyArtifact(source, materialized.treeDigest)) return failure("artifact-mismatch", "Materialized artifact does not match its bound digest");
  const digestName = materialized.treeDigest.slice("sha256:".length);
  if (!/^[a-f0-9]{64}$/.test(digestName)) return failure("artifact-mismatch", "Artifact digest is malformed");
  const destination = path.join(store.artifactsRoot, digestName);
  if (await verifyArtifact(destination, materialized.treeDigest)) {
    await fs.rm(source, { recursive: true, force: true });
    return { ok: true, value: { digest: materialized.treeDigest, path: destination, reused: true } };
  }
  const claim = path.join(store.artifactsRoot, `.${digestName}.publishing`);
  let claimHandle: Awaited<ReturnType<typeof fs.open>> | undefined;
  let published = false;
  try {
    await faults.hit("before-claim");
    claimHandle = await fs.open(claim, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    await claimHandle.sync(); await syncDirectory(store.artifactsRoot); await faults.hit("after-claim");
    if (await fs.lstat(destination).then(() => true, () => false)) return failure("artifact-collision", "Existing immutable artifact failed full verification");
    await faults.hit("before-publication");
    await fs.rename(source, destination); await syncDirectory(store.artifactsRoot); published = true;
    await faults.hit("after-publication");
    return { ok: true, value: { digest: materialized.treeDigest, path: destination, reused: false } };
  } catch {
    if (published && await verifyArtifact(destination, materialized.treeDigest)) {
      return { ok: true, value: { digest: materialized.treeDigest, path: destination, reused: false } };
    }
    return failure("artifact-publication", "Immutable artifact could not be durably published");
  } finally {
    await claimHandle?.close().catch(() => undefined);
    try { await faults.hit("before-claim-cleanup"); await fs.rm(claim, { force: true }); await syncDirectory(store.artifactsRoot); await faults.hit("after-claim-cleanup"); }
    catch { /* A stale claim is inactive and intentionally blocks uncertain reuse. */ }
  }
}

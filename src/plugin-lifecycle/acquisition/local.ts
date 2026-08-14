import { createHash } from "node:crypto";
import { constants, promises as fs, type BigIntStats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import { revalidateOwnedStateStore, issuePrivateStagingParent, type OwnedStateStore } from "../state-store.js";
import { routeCatalogPluginSource } from "../source-matrix.js";
import { PORTABLE_TREE_LIMITS, discardMaterializedPluginTree, materializePluginTree, validatePluginTree, type PluginTreeEntry } from "../tree-materializer.js";
import type { MarketplaceRegistrationSource, Sha256 } from "../types.js";
import {
  ACQUISITION_LIMITS,
  acquisitionFailure,
  exactMarketplaceSource,
  issueAcquisitionAuthorityForTrustedAdapter,
  issueMarketplaceSnapshotEvidence,
  parseBoundedJsonObject,
  throwIfCancelled,
  type AcquisitionContext,
  type AcquisitionFailure,
  type AcquisitionResult,
  type MarketplaceSnapshotEvidence,
} from "./common.js";

export interface LocalAcquisitionOptions extends AcquisitionContext {}

type FailureCode = AcquisitionFailure["error"]["code"];
class LocalFault extends Error { constructor(readonly code: FailureCode) { super(code); } }
const LOCAL_CATALOG_NOT_FOUND_MESSAGE = "The required local marketplace catalog was not found; add a catalog before retrying";

function ioFault(error: unknown, missing: "not-found" | "source-changed"): LocalFault {
  const code = (error as NodeJS.ErrnoException).code;
  return new LocalFault(code === "ENOENT" || code === "ENOTDIR" ? missing : "unreadable");
}

interface Identity {
  readonly dev: bigint; readonly ino: bigint; readonly size: bigint;
  readonly mtimeNs: bigint; readonly ctimeNs: bigint; readonly mode: bigint;
}
function identity(stat: BigIntStats): Identity {
  return { dev: stat.dev, ino: stat.ino, size: stat.size, mtimeNs: stat.mtimeNs, ctimeNs: stat.ctimeNs, mode: stat.mode };
}
function sameIdentity(left: Identity, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size
    && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs && left.mode === right.mode;
}
function equalPath(left: string, right: string): boolean {
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}
function contained(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

async function canonicalOrdinary(
  candidate: string,
  kind: "file" | "directory",
  missing: "not-found" | "source-changed" = "source-changed",
  bound = false,
): Promise<{ path: string; identity: Identity }> {
  let stat: BigIntStats;
  try { stat = await fs.lstat(path.resolve(candidate), { bigint: true }); }
  catch (error) { throw ioFault(error, missing); }
  const resolved = path.resolve(candidate);
  const ordinary = kind === "file" ? stat.isFile() && stat.nlink === 1n : stat.isDirectory();
  if (!ordinary || stat.isSymbolicLink()) throw new LocalFault(bound ? "source-changed" : "unsafe-source");
  let canonical: string;
  try { canonical = await fs.realpath(resolved); } catch (error) { throw ioFault(error, missing); }
  if (!equalPath(canonical, resolved)) throw new LocalFault("unsafe-source");
  return { path: resolved, identity: identity(stat) };
}

function storeRoots(store: OwnedStateStore): readonly string[] {
  return Object.freeze([...new Set([
    store.root, store.profileRoot, store.artifactsRoot, store.recordsRoot, store.stagingRoot,
    store.generationsRoot, store.journalsRoot, store.receiptsRoot, store.locksRoot, store.quarantineRoot,
  ].map((item) => path.resolve(item))) ]);
}
async function assertNoStorageOverlap(source: string, store: OwnedStateStore): Promise<void> {
  const valid = await revalidateOwnedStateStore(store);
  if (!valid.ok) throw new LocalFault("unsafe-source");
  for (const root of storeRoots(store)) {
    if (contained(root, source) || contained(source, root)) throw new LocalFault("storage-overlap");
  }
}

async function readCaptured(handle: FileHandle, size: number, signal: AbortSignal | undefined): Promise<Uint8Array> {
  const output = Buffer.alloc(size);
  let offset = 0;
  while (offset < size) {
    throwIfCancelled(signal);
    let bytesRead: number;
    try { bytesRead = (await handle.read(output, offset, Math.min(64 * 1024, size - offset), offset)).bytesRead; }
    catch (error) { throw ioFault(error, "source-changed"); }
    if (bytesRead === 0) throw new LocalFault("source-changed");
    offset += bytesRead;
  }
  const extra = Buffer.alloc(1);
  try {
    if ((await handle.read(extra, 0, 1, size)).bytesRead !== 0) throw new LocalFault("source-changed");
  } catch (error) {
    if (error instanceof LocalFault) throw error;
    throw ioFault(error, "source-changed");
  }
  return output;
}

async function readStableFile(file: string, signal: AbortSignal | undefined, maximumBytes = PORTABLE_TREE_LIMITS.maximumFileBytes): Promise<{ data: Uint8Array; identity: Identity }> {
  throwIfCancelled(signal);
  const bound = await canonicalOrdinary(file, "file", "source-changed", true);
  if (bound.identity.size > BigInt(maximumBytes)) throw new LocalFault("limit-exceeded");
  if (process.platform !== "win32" && (bound.identity.mode & 0o444n) === 0n) throw new LocalFault("unreadable");
  let handle: FileHandle;
  try { handle = await fs.open(bound.path, constants.O_RDONLY); } catch (error) { throw ioFault(error, "source-changed"); }
  try {
    let opened: BigIntStats;
    try { opened = await handle.stat({ bigint: true }); } catch (error) { throw ioFault(error, "source-changed"); }
    if (!sameIdentity(bound.identity, opened)) throw new LocalFault("source-changed");
    const data = await readCaptured(handle, Number(bound.identity.size), signal);
    try {
      if (!sameIdentity(bound.identity, await handle.stat({ bigint: true }))) throw new LocalFault("source-changed");
      if (!sameIdentity(bound.identity, await fs.lstat(bound.path, { bigint: true }))) throw new LocalFault("source-changed");
    } catch (error) {
      if (error instanceof LocalFault) throw error;
      throw ioFault(error, "source-changed");
    }
    return { data, identity: bound.identity };
  } finally { await handle.close(); }
}

interface WalkBudget { entries: number; totalBytes: number }
interface BoundDirectory { readonly path: string; readonly identity: Identity; readonly names: ReadonlySet<string> }

async function iterateNames(directory: string, maximum: number, signal: AbortSignal | undefined): Promise<Set<string>> {
  const names = new Set<string>();
  let handle: Awaited<ReturnType<typeof fs.opendir>>;
  try { handle = await fs.opendir(directory); } catch (error) { throw ioFault(error, "source-changed"); }
  try {
    for await (const entry of handle) {
      throwIfCancelled(signal);
      if (names.size >= maximum) throw new LocalFault("limit-exceeded");
      if (names.has(entry.name)) throw new LocalFault("source-changed");
      names.add(entry.name);
    }
  } catch (error) {
    if (error instanceof LocalFault || error instanceof DOMException) throw error;
    throw ioFault(error, "source-changed");
  } finally { await handle.close().catch(() => undefined); }
  return names;
}

async function walkDirectory(root: string, relative: string, output: Map<string, PluginTreeEntry>, signal: AbortSignal | undefined, budget: WalkBudget, bindings: BoundDirectory[]): Promise<void> {
  throwIfCancelled(signal);
  const directory = relative === "" ? root : path.join(root, ...relative.split("/"));
  const bound = await canonicalOrdinary(directory, "directory", "source-changed", true);
  if (relative !== "" && !output.has(relative)) {
    if (++budget.entries > PORTABLE_TREE_LIMITS.maximumEntries) throw new LocalFault("limit-exceeded");
    output.set(relative, Object.freeze({ path: relative, kind: "directory" }));
  }
  const names = await iterateNames(directory, PORTABLE_TREE_LIMITS.maximumEntries - budget.entries + 1, signal);
  bindings.push({ path: directory, identity: bound.identity, names });
  for (const name of names) {
    const childRelative = relative === "" ? name : `${relative}/${name}`;
    const child = path.join(directory, name);
    let stat: BigIntStats;
    try { stat = await fs.lstat(child, { bigint: true }); } catch (error) { throw ioFault(error, "source-changed"); }
    if (stat.isDirectory() && !stat.isSymbolicLink()) {
      await walkDirectory(root, childRelative, output, signal, budget, bindings);
    } else if (stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1n) {
      const stable = await readStableFile(child, signal);
      if (!output.has(childRelative)) { budget.entries += 1; budget.totalBytes += stable.data.byteLength; }
      if (budget.entries > PORTABLE_TREE_LIMITS.maximumEntries || budget.totalBytes > PORTABLE_TREE_LIMITS.maximumTotalBytes) throw new LocalFault("limit-exceeded");
      output.set(childRelative, Object.freeze({ path: childRelative, kind: "file", data: stable.data, executable: process.platform !== "win32" && (stable.identity.mode & 0o111n) !== 0n }));
    } else throw new LocalFault("unsafe-source");
  }
}

async function revalidateDirectories(bindings: readonly BoundDirectory[], signal: AbortSignal | undefined): Promise<void> {
  for (const binding of bindings) {
    throwIfCancelled(signal);
    let current: BigIntStats;
    try { current = await fs.lstat(binding.path, { bigint: true }); } catch (error) { throw ioFault(error, "source-changed"); }
    if (!sameIdentity(binding.identity, current)) throw new LocalFault("source-changed");
    const names = await iterateNames(binding.path, binding.names.size + 1, signal);
    if (names.size !== binding.names.size || [...names].some((name) => !binding.names.has(name))) throw new LocalFault("source-changed");
  }
}

function catalogRelativeRoots(catalog: Uint8Array, marketplaceKind: MarketplaceRegistrationSource["kind"]): readonly string[] {
  const value = parseBoundedJsonObject(catalog);
  if (value === undefined || !Array.isArray(value["plugins"])) throw new LocalFault("invalid-catalog");
  const metadata = typeof value["metadata"] === "object" && value["metadata"] !== null && !Array.isArray(value["metadata"])
    ? value["metadata"] as Record<string, unknown> : undefined;
  const pluginRoot = typeof metadata?.["pluginRoot"] === "string" ? metadata["pluginRoot"] : undefined;
  const roots = new Set<string>();
  for (const plugin of value["plugins"]) {
    if (typeof plugin !== "object" || plugin === null || Array.isArray(plugin)) continue;
    const raw = (plugin as Record<string, unknown>)["source"];
    if (typeof raw !== "string") continue;
    const routed = routeCatalogPluginSource(raw, { marketplaceSourceKind: marketplaceKind, ...(pluginRoot === undefined ? {} : { metadataPluginRoot: pluginRoot }) });
    if (!routed.ok || routed.value.descriptor.kind !== "relative") continue;
    roots.add([routed.value.descriptor.pluginRoot, routed.value.descriptor.path].filter((item): item is string => item !== undefined).join("/"));
  }
  return [...roots];
}
function digestBytes(bytes: Uint8Array): Sha256 { return `sha256:${createHash("sha256").update(bytes).digest("hex")}`; }
function snapshotId(catalogDigest: Sha256, treeDigest: Sha256): `marketplace-${string}` {
  return `marketplace-${createHash("sha256").update(`${catalogDigest}\0${treeDigest}`).digest("base64url")}`;
}

export async function acquireLocalMarketplaceSnapshot(sourceValue: MarketplaceRegistrationSource, options: LocalAcquisitionOptions): Promise<AcquisitionResult<MarketplaceSnapshotEvidence>> {
  const source = exactMarketplaceSource(sourceValue);
  if (source === undefined || (source.kind !== "local-directory" && source.kind !== "local-catalog-file")) return acquisitionFailure("unsafe-source", "The source is not an exact supported local marketplace declaration");
  try {
    throwIfCancelled(options.signal);
    const input = await canonicalOrdinary(source.path, source.kind === "local-directory" ? "directory" : "file", "not-found");
    await assertNoStorageOverlap(input.path, options.store);
    const parent = source.kind === "local-directory" ? input : await canonicalOrdinary(path.dirname(input.path), "directory");
    await assertNoStorageOverlap(parent.path, options.store);
    const snapshotRoot = parent.path;
    const catalogPath = source.kind === "local-directory" ? path.join(input.path, ".claude-plugin", "marketplace.json") : input.path;
    let catalogBound: Awaited<ReturnType<typeof canonicalOrdinary>>;
    try {
      catalogBound = await canonicalOrdinary(catalogPath, "file", source.kind === "local-directory" ? "not-found" : "source-changed");
    } catch (error) {
      if (source.kind === "local-directory" && error instanceof LocalFault && error.code === "not-found") {
        return acquisitionFailure("not-found", LOCAL_CATALOG_NOT_FOUND_MESSAGE);
      }
      throw error;
    }
    await assertNoStorageOverlap(catalogBound.path, options.store);
    if (!contained(snapshotRoot, catalogBound.path)) throw new LocalFault("unsafe-source");
    const catalog = await readStableFile(catalogBound.path, options.signal, ACQUISITION_LIMITS.maximumCatalogBytes);
    if (parseBoundedJsonObject(catalog.data) === undefined) throw new LocalFault("invalid-catalog");
    const entries = new Map<string, PluginTreeEntry>();
    const budget: WalkBudget = { entries: 0, totalBytes: 0 };
    const bindings: BoundDirectory[] = [];
    if (source.kind === "local-directory") {
      await walkDirectory(snapshotRoot, "", entries, options.signal, budget, bindings);
    } else {
      const catalogRelative = path.relative(snapshotRoot, catalogPath).split(path.sep).join("/");
      entries.set(catalogRelative, Object.freeze({ path: catalogRelative, kind: "file", data: catalog.data, executable: false }));
      budget.entries = 1; budget.totalBytes = catalog.data.byteLength;
      for (const relativeRoot of catalogRelativeRoots(catalog.data, source.kind)) {
        const selected = path.resolve(snapshotRoot, ...relativeRoot.split("/"));
        if (!contained(snapshotRoot, selected) || equalPath(selected, snapshotRoot)) throw new LocalFault("unsafe-source");
        const selectedIdentity = await canonicalOrdinary(selected, "directory");
        await assertNoStorageOverlap(selectedIdentity.path, options.store);
        if (!contained(snapshotRoot, selectedIdentity.path)) throw new LocalFault("unsafe-source");
        await walkDirectory(snapshotRoot, relativeRoot, entries, options.signal, budget, bindings);
      }
    }
    await revalidateDirectories(bindings, options.signal);
    const catalogAfter = await readStableFile(catalogPath, options.signal, ACQUISITION_LIMITS.maximumCatalogBytes);
    let catalogStat: BigIntStats; let inputStat: BigIntStats; let parentStat: BigIntStats;
    try {
      catalogStat = await fs.lstat(catalogPath, { bigint: true });
      inputStat = await fs.lstat(input.path, { bigint: true });
      parentStat = await fs.lstat(parent.path, { bigint: true });
    } catch (error) { throw ioFault(error, "source-changed"); }
    if (!sameIdentity(catalog.identity, catalogStat) || !Buffer.from(catalog.data).equals(catalogAfter.data)) throw new LocalFault("source-changed");
    if (!sameIdentity(input.identity, inputStat) || !sameIdentity(parent.identity, parentStat)) throw new LocalFault("source-changed");
    await assertNoStorageOverlap(input.path, options.store);
    const plan = validatePluginTree([...entries.values()], { kind: "tree-root" });
    if (!plan.ok) throw new LocalFault("unsafe-source");
    const staging = await issuePrivateStagingParent(options.store);
    if (!staging.ok) throw new LocalFault("unsafe-source");
    const materialized = await materializePluginTree(plan.value, staging.value);
    if (!materialized.ok) throw new LocalFault("unsafe-source");
    if (options.signal?.aborted === true) {
      await discardMaterializedPluginTree(materialized.value);
      return acquisitionFailure("cancelled", "Local marketplace acquisition was cancelled before evidence issuance");
    }
    const catalogDigest = digestBytes(catalog.data);
    return { ok: true, value: issueMarketplaceSnapshotEvidence({
      kind: "marketplace-snapshot", source,
      snapshotId: snapshotId(catalogDigest, materialized.value.treeDigest), catalogDigest, materialized: materialized.value,
      provenance: Object.freeze({ adapter: source.kind === "local-directory" ? "local-directory-snapshot" : "local-catalog-snapshot", reviewed: Object.freeze({ kind: "local-path" as const, canonicalPath: input.path }), artifactDigest: materialized.value.treeDigest, selectedRoot: materialized.value.rootSelection }),
    }, { catalog: catalog.data, entries: Object.freeze([...entries.values()]) }, issueAcquisitionAuthorityForTrustedAdapter(source.kind === "local-directory" ? "local-directory-snapshot" : "local-catalog-snapshot")) };
  } catch (error) {
    if (options.signal?.aborted === true || (error instanceof DOMException && error.name === "AbortError")) return acquisitionFailure("cancelled", "Local marketplace acquisition was cancelled");
    const code = error instanceof LocalFault ? error.code : "source-changed";
    const messages: Record<FailureCode, string> = {
      cancelled: "Local marketplace acquisition was cancelled", "not-found": "The local marketplace source was not found", unreadable: "The local marketplace source was unreadable",
      "storage-overlap": "The local marketplace source overlaps PiCC-owned lifecycle storage", "unsafe-source": "The local marketplace source is unsafe", "source-changed": "The local marketplace source changed during snapshotting",
      "limit-exceeded": "The local marketplace source exceeds snapshot limits", "download-limit": "The local marketplace source exceeds snapshot limits", timeout: "The local marketplace source could not be read in time",
      "network-failure": "The local marketplace source could not be read", "invalid-catalog": "The local marketplace catalog is invalid", "invalid-archive": "The local marketplace source is invalid", integrity: "The local marketplace source changed during snapshotting",
    };
    return acquisitionFailure(code, messages[code]);
  }
}

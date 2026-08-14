import { createHash } from "node:crypto";
import type { Readable } from "node:stream";
import * as yauzl from "yauzl";
import { issuePrivateStagingParent } from "../state-store.js";
import { PORTABLE_TREE_LIMITS, discardMaterializedPluginTree, materializePluginTree, validatePluginTree, type PluginTreeEntry } from "../tree-materializer.js";
import type { CatalogPluginSource, Sha256 } from "../types.js";
import {
  ACQUISITION_LIMITS,
  acquisitionFailure,
  exactZipSource,
  issueAcquisitionAuthorityForTrustedAdapter,
  issuePluginAcquisitionEvidence,
  type AcquisitionContext,
  type AcquisitionResult,
  type PluginAcquisitionEvidence,
} from "./common.js";
import { fetchPublicHttps, type PublicHttpsFetchOptions } from "./http.js";

export interface ZipAcquisitionOptions extends AcquisitionContext, PublicHttpsFetchOptions {}

const CRC_TABLE = new Uint32Array(256);
for (let value = 0; value < 256; value += 1) {
  let crc = value;
  for (let bit = 0; bit < 8; bit += 1) crc = (crc & 1) === 0 ? crc >>> 1 : (crc >>> 1) ^ 0xedb88320;
  CRC_TABLE[value] = crc >>> 0;
}

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ byte) & 0xff]!;
  return (crc ^ 0xffffffff) >>> 0;
}

function artifactDigest(data: Uint8Array): Sha256 {
  return `sha256:${createHash("sha256").update(data).digest("hex")}`;
}

function unixType(entry: yauzl.Entry): number | undefined {
  return (entry.versionMadeBy >>> 8) === 3 ? (entry.externalFileAttributes >>> 16) & 0o170000 : undefined;
}

class ZipFault extends Error {
  constructor(readonly code: "invalid-archive" | "limit-exceeded") { super(code); }
}

function entryKind(entry: yauzl.Entry): "directory" | "file" | undefined {
  const type = unixType(entry);
  const namedDirectory = entry.fileName.endsWith("/");
  if (type !== undefined && type !== 0 && type !== 0o040000 && type !== 0o100000) return undefined;
  if (namedDirectory || type === 0o040000) return namedDirectory && type !== 0o100000 ? "directory" : undefined;
  return "file";
}

async function readBoundedStream(
  stream: Readable,
  expected: number,
  maximum: number,
  signal: AbortSignal | undefined,
): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  let total = 0;
  const abort = (): void => { stream.destroy(new DOMException("cancelled", "AbortError")); };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    for await (const chunk of stream) {
      if (signal?.aborted === true) throw new DOMException("cancelled", "AbortError");
      const bytes = Buffer.from(chunk as Uint8Array);
      total += bytes.byteLength;
      if (total > maximum) throw new ZipFault("limit-exceeded");
      if (total > expected) throw new ZipFault("invalid-archive");
      chunks.push(bytes);
    }
  } finally {
    signal?.removeEventListener("abort", abort);
  }
  if (total !== expected) throw new ZipFault("invalid-archive");
  return Buffer.concat(chunks);
}

export async function parseZipPluginTree(
  bytes: Uint8Array,
  signal?: AbortSignal,
): Promise<AcquisitionResult<readonly PluginTreeEntry[]>> {
  let zip: yauzl.ZipFile | undefined;
  const abort = (): void => { zip?.close(); };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    if (signal?.aborted === true) throw new DOMException("cancelled", "AbortError");
    zip = await yauzl.fromBufferPromise(Buffer.from(bytes), {
      lazyEntries: true,
      autoClose: false,
      decodeStrings: true,
      validateEntrySizes: true,
      strictFileNames: true,
    });
    if (zip.entryCount < 1) throw new ZipFault("invalid-archive");
    if (zip.entryCount > PORTABLE_TREE_LIMITS.maximumEntries) throw new ZipFault("limit-exceeded");
    const entries: PluginTreeEntry[] = [];
    let totalBytes = 0;
    for await (const entry of zip.eachEntry()) {
      if (Boolean(signal?.aborted)) throw new DOMException("cancelled", "AbortError");
      if (entry.isEncrypted() || !entry.canDecodeFileData() || (entry.compressionMethod !== 0 && entry.compressionMethod !== 8)) {
        throw new ZipFault("invalid-archive");
      }
      const kind = entryKind(entry);
      if (kind === undefined) throw new ZipFault("invalid-archive");
      const entryPath = kind === "directory" ? entry.fileName.slice(0, -1) : entry.fileName;
      if (kind === "directory") {
        entries.push(Object.freeze({ path: entryPath, kind }));
        continue;
      }
      if (entry.uncompressedSize > PORTABLE_TREE_LIMITS.maximumFileBytes
        || (entry.compressedSize > 0 && entry.uncompressedSize / entry.compressedSize > 200)) {
        throw new ZipFault("limit-exceeded");
      }
      totalBytes += entry.uncompressedSize;
      if (totalBytes > PORTABLE_TREE_LIMITS.maximumTotalBytes) throw new ZipFault("limit-exceeded");
      const stream = await zip.openReadStreamPromise(entry);
      const data = await readBoundedStream(stream, entry.uncompressedSize, PORTABLE_TREE_LIMITS.maximumFileBytes, signal);
      if (crc32(data) !== entry.crc32) throw new ZipFault("invalid-archive");
      const mode = (entry.externalFileAttributes >>> 16) & 0o777;
      entries.push(Object.freeze({ path: entryPath, kind, data, executable: (mode & 0o111) !== 0 }));
    }
    const portable = validatePluginTree(entries, { kind: "tree-root" });
    if (!portable.ok) throw new ZipFault("invalid-archive");
    return { ok: true, value: Object.freeze(entries) };
  } catch (error) {
    if (signal?.aborted === true || (error instanceof DOMException && error.name === "AbortError")) {
      return acquisitionFailure("cancelled", "ZIP acquisition was cancelled");
    }
    if (error instanceof ZipFault && error.code === "limit-exceeded") {
      return acquisitionFailure("limit-exceeded", "The ZIP artifact exceeds portable archive limits");
    }
    return acquisitionFailure("invalid-archive", "The ZIP artifact is malformed, unsupported, or unsafe");
  } finally {
    signal?.removeEventListener("abort", abort);
    zip?.close();
  }
}

export async function acquireHttpsZipPlugin(
  source: CatalogPluginSource,
  options: ZipAcquisitionOptions,
): Promise<AcquisitionResult<PluginAcquisitionEvidence>> {
  const exactSource = exactZipSource(source);
  if (exactSource === undefined) return acquisitionFailure("unsafe-source", "The source is not an exact official HTTPS ZIP declaration");
  const fetched = await fetchPublicHttps(exactSource.url, {
    ...options,
    maximumBodyBytes: Math.min(options.maximumBodyBytes ?? ACQUISITION_LIMITS.maximumDownloadBytes, ACQUISITION_LIMITS.maximumDownloadBytes),
  });
  if (!fetched.ok) return fetched;
  const downloadedDigest = artifactDigest(fetched.value.body);
  if (exactSource.sha256 !== undefined && `sha256:${exactSource.sha256}` !== downloadedDigest) {
    return acquisitionFailure("integrity", "The ZIP artifact does not match the declared SHA-256 integrity");
  }
  const parsed = await parseZipPluginTree(fetched.value.body, options.signal);
  if (!parsed.ok) return parsed;
  const plan = validatePluginTree(parsed.value, { kind: "root-or-single-wrapper" });
  if (!plan.ok) return acquisitionFailure("invalid-archive", "The ZIP artifact does not contain one portable root-or-wrapper plugin tree");
  const staging = await issuePrivateStagingParent(options.store);
  if (!staging.ok) return acquisitionFailure("unsafe-source", "The ZIP staging authority is unavailable");
  const materialized = await materializePluginTree(plan.value, staging.value);
  if (!materialized.ok) return acquisitionFailure("invalid-archive", "The ZIP plugin tree could not be materialized safely");
  if (options.signal?.aborted === true) {
    await discardMaterializedPluginTree(materialized.value);
    return acquisitionFailure("cancelled", "ZIP acquisition was cancelled before evidence issuance");
  }
  return { ok: true, value: issuePluginAcquisitionEvidence({
    kind: "plugin-acquisition",
    source: exactSource,
    artifactDigest: downloadedDigest,
    treeDigest: materialized.value.treeDigest,
    rootDigest: materialized.value.rootDigest,
    materialized: materialized.value,
    provenance: Object.freeze({
      adapter: "public-https-zip",
      reviewed: fetched.value.reviewed,
      artifactDigest: downloadedDigest,
      selectedRoot: materialized.value.rootSelection,
    }),
  }, issueAcquisitionAuthorityForTrustedAdapter("public-https-zip")) };
}

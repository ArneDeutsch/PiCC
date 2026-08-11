import { createHash, timingSafeEqual } from "node:crypto";
import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import semver from "semver";
import * as tar from "tar-stream";
import { routeCatalogPluginSource } from "../source-matrix.js";
import { issuePrivateStagingParent } from "../state-store.js";
import {
  PORTABLE_TREE_LIMITS,
  discardMaterializedPluginTree,
  materializePluginTree,
  validatePluginTree,
  type MaterializedPluginTree,
  type PluginTreeEntry,
} from "../tree-materializer.js";
import type { CatalogPluginSource, Sha256 } from "../types.js";
import {
  ACQUISITION_LIMITS,
  acquisitionFailure,
  parseBoundedJsonObject,
  type AcquisitionContext,
  type AcquisitionResult,
  type ReviewedHttpIdentity,
} from "./common.js";
import { fetchPublicHttps, type PublicHttpsFetchOptions } from "./http.js";

const NPM_REGISTRY = "https://registry.npmjs.org";
const SHA512_SRI = /^sha512-([A-Za-z0-9+/]{86}==)$/;
const TAR_BLOCK_BYTES = 512;
const MAXIMUM_TAR_HEADERS = PORTABLE_TREE_LIMITS.maximumEntries + 1;
// Payload plus one header and worst-case padding per admitted logical entry, the package/ wrapper, and the end marker.
const MAXIMUM_DECOMPRESSED_TAR_BYTES = PORTABLE_TREE_LIMITS.maximumTotalBytes
  + MAXIMUM_TAR_HEADERS * (TAR_BLOCK_BYTES + TAR_BLOCK_BYTES - 1)
  + TAR_BLOCK_BYTES * 2;

declare const postMaterializationWitnessBrand: unique symbol;
export interface NpmPostMaterializationWitness { readonly [postMaterializationWitnessBrand]: true }
const postMaterializationWitnesses = new WeakMap<NpmPostMaterializationWitness, () => void>();
export function issueNpmPostMaterializationWitnessForTest(trigger: () => void): NpmPostMaterializationWitness {
  if (process.env["VITEST"] !== "true") throw new Error("npm post-materialization witnesses are test-only");
  const capability = Object.freeze({}) as NpmPostMaterializationWitness;
  postMaterializationWitnesses.set(capability, trigger);
  return capability;
}

export interface NpmAcquisitionOptions extends AcquisitionContext, PublicHttpsFetchOptions {
  readonly postMaterializationWitness?: NpmPostMaterializationWitness;
}

type NpmSource = Extract<CatalogPluginSource, { readonly kind: "npm" }>;

function plain(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  return (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
    && Object.getOwnPropertySymbols(value).length === 0
    && Object.values(descriptors).every((descriptor) => descriptor.get === undefined && descriptor.set === undefined);
}

function exactNpmSource(value: unknown): NpmSource | undefined {
  if (!plain(value)) return undefined;
  const routed = routeCatalogPluginSource({
    source: "npm",
    package: value["package"],
    ...(value["version"] === undefined ? {} : { version: value["version"] }),
    registry: value["registry"],
  }, { marketplaceSourceKind: "local-directory" });
  if (!routed.ok || routed.value.descriptor.kind !== "npm") return undefined;
  const source = routed.value.descriptor;
  const sourceKeys = Object.keys(source).sort();
  const valueKeys = Object.keys(value).sort();
  return sourceKeys.length === valueKeys.length
    && sourceKeys.every((key, index) => key === valueKeys[index])
    && value["kind"] === source.kind
    && value["package"] === source.package
    && value["version"] === source.version
    && value["registry"] === source.registry
    ? source
    : undefined;
}

function registryUrl(pathname: string): string {
  return `${NPM_REGISTRY}/${pathname}`;
}

function admittedRegistryUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const parsed = new URL(value);
    return parsed.origin === NPM_REGISTRY && parsed.username === "" && parsed.password === ""
      && parsed.search === "" && parsed.hash === "" && parsed.port === "" && parsed.pathname.startsWith("/")
      ? parsed.href
      : undefined;
  } catch {
    return undefined;
  }
}

function exactSha512Integrity(value: unknown): { readonly text: string; readonly digest: Buffer } | undefined {
  if (typeof value !== "string") return undefined;
  const match = SHA512_SRI.exec(value);
  if (match === null) return undefined;
  const digest = Buffer.from(match[1]!, "base64");
  return digest.byteLength === 64 && digest.toString("base64") === match[1]
    ? { text: value, digest }
    : undefined;
}

interface NpmMetadata {
  readonly versions: ReadonlyMap<string, Record<string, unknown>>;
  readonly tags: Readonly<Record<string, string>>;
}

function npmMetadata(metadata: Record<string, unknown>, packageName: string): NpmMetadata | undefined {
  if (metadata["name"] !== packageName || !plain(metadata["versions"]) || !plain(metadata["dist-tags"])) return undefined;
  const versions = new Map<string, Record<string, unknown>>();
  for (const [version, document] of Object.entries(metadata["versions"])) {
    if (semver.valid(version) !== version || !plain(document)
      || document["name"] !== packageName || document["version"] !== version) return undefined;
    versions.set(version, document);
  }
  if (versions.size === 0) return undefined;
  const tags: Record<string, string> = {};
  for (const [tag, version] of Object.entries(metadata["dist-tags"])) {
    if (typeof version !== "string" || semver.valid(version) !== version || !versions.has(version)) return undefined;
    tags[tag] = version;
  }
  return Object.freeze({ versions, tags: Object.freeze(tags) });
}

function resolveVersion(metadata: NpmMetadata, selector: string): string | undefined {
  if (Object.hasOwn(metadata.tags, selector)) return metadata.tags[selector];
  const exact = semver.valid(selector);
  if (exact !== null) return metadata.versions.has(exact) ? exact : undefined;
  const range = semver.validRange(selector);
  return range === null ? undefined : semver.maxSatisfying([...metadata.versions.keys()], range) ?? undefined;
}

function redirectUnsupported(result: AcquisitionResult<unknown>, surface: "metadata" | "tarball"): AcquisitionResult<never> | undefined {
  return !result.ok && result.error.code === "network-failure" && result.error.message === "The HTTP redirect limit was exceeded"
    ? acquisitionFailure("unsafe-source", `npm ${surface} redirects are unsupported because every hop cannot be proven credential-safe; retry from public ${NPM_REGISTRY}`)
    : undefined;
}

declare const previewBrand: unique symbol;
export interface ResolvedNpmPluginPreview {
  readonly [previewBrand]: true;
  readonly source: NpmSource;
  readonly package: string;
  readonly requestedSelector: string;
  readonly version: string;
  readonly registryOrigin: typeof NPM_REGISTRY;
  readonly integrity: string;
  readonly tarballUrl: string;
  readonly reviewedMetadata: ReviewedHttpIdentity;
  readonly packageRoot: "package/";
}

interface PreviewPrivate { readonly integrityDigest: Buffer }
const previews = new WeakMap<ResolvedNpmPluginPreview, PreviewPrivate>();

export async function resolveNpmPluginSource(
  sourceValue: unknown,
  options: Omit<NpmAcquisitionOptions, "store"> = {},
): Promise<AcquisitionResult<ResolvedNpmPluginPreview>> {
  const source = exactNpmSource(sourceValue);
  if (source === undefined) {
    return acquisitionFailure("unsafe-source", `Use an exact npm declaration from public ${NPM_REGISTRY}; custom registries and credentials are unsupported`);
  }
  const metadataUrl = registryUrl(encodeURIComponent(source.package));
  // Redirects stay disabled: the shared fetch result cannot prove that every prior hop remained on npmjs.
  const fetched = await fetchPublicHttps(metadataUrl, {
    ...options,
    maximumBodyBytes: Math.min(options.maximumBodyBytes ?? ACQUISITION_LIMITS.maximumCatalogBytes, ACQUISITION_LIMITS.maximumCatalogBytes),
    maximumRedirects: 0,
  });
  if (!fetched.ok) return redirectUnsupported(fetched, "metadata") ?? fetched;
  if (fetched.value.reviewed.origin !== NPM_REGISTRY || fetched.value.redirectCount !== 0) {
    return acquisitionFailure("unsafe-source", `npm metadata must come directly from public ${NPM_REGISTRY}`);
  }
  const rawMetadata = parseBoundedJsonObject(fetched.value.body);
  if (rawMetadata === undefined) {
    return acquisitionFailure("invalid-catalog", `npm metadata for ${source.package} is not a bounded JSON object; retry resolution`);
  }
  const metadata = npmMetadata(rawMetadata, source.package);
  if (metadata === undefined) {
    return acquisitionFailure("invalid-catalog", `npm metadata for ${source.package} has an invalid versions or dist-tags schema; retry resolution`);
  }
  const requestedSelector = source.version ?? "latest";
  const version = resolveVersion(metadata, requestedSelector);
  if (version === undefined) {
    return acquisitionFailure("not-found", `npm package ${source.package} does not publish selector ${requestedSelector}; choose an available version or tag and resolve again`);
  }
  const dist = metadata.versions.get(version)?.["dist"];
  if (!plain(dist)) {
    return acquisitionFailure("invalid-catalog", `npm metadata for ${source.package}@${version} has an invalid distribution document; retry resolution`);
  }
  const integrity = exactSha512Integrity(dist["integrity"]);
  if (integrity === undefined) {
    return acquisitionFailure("integrity", `npm package ${source.package}@${version} lacks one exact SHA-512 integrity value; choose a published version with SHA-512 evidence`);
  }
  const tarballUrl = admittedRegistryUrl(dist["tarball"]);
  if (tarballUrl === undefined) {
    return acquisitionFailure("unsafe-source", `npm package ${source.package}@${version} must use a credential-free tarball on public ${NPM_REGISTRY}`);
  }
  const preview = Object.freeze({
    source,
    package: source.package,
    requestedSelector,
    version,
    registryOrigin: NPM_REGISTRY,
    integrity: integrity.text,
    tarballUrl,
    reviewedMetadata: fetched.value.reviewed,
    packageRoot: "package/",
  }) as ResolvedNpmPluginPreview;
  previews.set(preview, Object.freeze({ integrityDigest: Buffer.from(integrity.digest) }));
  return { ok: true, value: preview };
}

class TarFault extends Error {
  constructor(readonly kind: "invalid" | "limit" | "cancelled") { super(kind); }
}

function tarNumber(field: Uint8Array): number | undefined {
  if ((field[0] ?? 0) >= 0x80) return undefined;
  const text = Buffer.from(field).toString("ascii").replace(/\0.*$/s, "").trim();
  if (!/^[0-7]+$/.test(text)) return undefined;
  const value = Number.parseInt(text, 8);
  return Number.isSafeInteger(value) ? value : undefined;
}

function inspectRawTar(bytes: Uint8Array): void {
  let offset = 0;
  let headers = 0;
  let payloadBytes = 0;
  let endBlocks = 0;
  while (offset + TAR_BLOCK_BYTES <= bytes.byteLength) {
    const block = bytes.subarray(offset, offset + TAR_BLOCK_BYTES);
    if (block.every((byte) => byte === 0)) {
      endBlocks += 1;
      offset += TAR_BLOCK_BYTES;
      if (endBlocks === 2) break;
      continue;
    }
    if (endBlocks !== 0) throw new TarFault("invalid");
    headers += 1;
    if (headers > MAXIMUM_TAR_HEADERS) throw new TarFault("limit");
    const size = tarNumber(block.subarray(124, 136));
    if (size === undefined) throw new TarFault("invalid");
    if (block[156] === 0x35 && size !== 0) throw new TarFault("invalid");
    payloadBytes += size;
    if (payloadBytes > PORTABLE_TREE_LIMITS.maximumTotalBytes) throw new TarFault("limit");
    const paddedSize = Math.ceil(size / TAR_BLOCK_BYTES) * TAR_BLOCK_BYTES;
    offset += TAR_BLOCK_BYTES;
    if (offset + paddedSize > bytes.byteLength) throw new TarFault("invalid");
    offset += paddedSize;
  }
  if (endBlocks !== 2 || bytes.subarray(offset).some((byte) => byte !== 0)) throw new TarFault("invalid");
}

async function boundedGunzip(bytes: Uint8Array, signal: AbortSignal | undefined): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  const sink = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      total += chunk.byteLength;
      if (total > MAXIMUM_DECOMPRESSED_TAR_BYTES) callback(new TarFault("limit"));
      else { chunks.push(Buffer.from(chunk)); callback(); }
    },
  });
  try {
    await pipeline(Readable.from(Buffer.from(bytes)), createGunzip(), sink, ...(signal === undefined ? [] : [{ signal }]));
  } catch (error) {
    if (signal?.aborted === true) throw new TarFault("cancelled");
    throw error;
  }
  return Buffer.concat(chunks);
}

export async function parseNpmPackageTree(
  bytes: Uint8Array,
  signal?: AbortSignal,
): Promise<AcquisitionResult<readonly PluginTreeEntry[]>> {
  const extract = tar.extract();
  const entries: PluginTreeEntry[] = [];
  let totalBytes = 0;
  let settled = false;
  try {
    if (signal?.aborted === true) throw new TarFault("cancelled");
    const decompressed = await boundedGunzip(bytes, signal);
    inspectRawTar(decompressed);
    await new Promise<void>((resolve, reject) => {
      const fail = (error: unknown): void => { if (!settled) { settled = true; reject(error); } };
      const abort = (): void => { fail(new TarFault("cancelled")); extract.destroy(); };
      signal?.addEventListener("abort", abort, { once: true });
      extract.on("entry", (header, stream, next) => {
        void (async () => {
          try {
            if (signal?.aborted === true) throw new TarFault("cancelled");
            if (header.name === "package" || header.name === "package/") {
              if (header.type !== "directory" || header.size !== 0) throw new TarFault("invalid");
              stream.resume();
              await new Promise<void>((done, failed) => { stream.once("end", done); stream.once("error", failed); });
              next();
              return;
            }
            if (!header.name.startsWith("package/")) throw new TarFault("invalid");
            const logicalPath = header.name.slice("package/".length).replace(/\/$/, "");
            if (logicalPath.length === 0 || (header.type !== "file" && header.type !== "directory")) throw new TarFault("invalid");
            if (header.type === "directory") {
              if (header.size !== 0) throw new TarFault("invalid");
              entries.push(Object.freeze({ path: logicalPath, kind: "directory" }));
              stream.resume();
              await new Promise<void>((done, failed) => { stream.once("end", done); stream.once("error", failed); });
              next();
              return;
            }
            const size = header.size;
            if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 0 || size > PORTABLE_TREE_LIMITS.maximumFileBytes) throw new TarFault("limit");
            totalBytes += size;
            if (totalBytes > PORTABLE_TREE_LIMITS.maximumTotalBytes) throw new TarFault("limit");
            const chunks: Buffer[] = [];
            let observed = 0;
            for await (const chunk of stream) {
              if (Boolean(signal?.aborted)) throw new TarFault("cancelled");
              const data = Buffer.from(chunk as Uint8Array);
              observed += data.byteLength;
              if (observed > size) throw new TarFault("invalid");
              chunks.push(data);
            }
            if (observed !== size) throw new TarFault("invalid");
            entries.push(Object.freeze({ path: logicalPath, kind: "file", data: Buffer.concat(chunks), executable: ((header.mode ?? 0) & 0o111) !== 0 }));
            next();
          } catch (error) {
            fail(error);
            stream.resume();
            extract.destroy();
          }
        })();
      });
      extract.once("finish", () => { signal?.removeEventListener("abort", abort); if (!settled) { settled = true; resolve(); } });
      extract.on("error", fail);
      extract.end(decompressed);
    });
    if (entries.length === 0) throw new TarFault("invalid");
    const validated = validatePluginTree(entries, { kind: "tree-root" });
    if (!validated.ok) throw new TarFault("invalid");
    return { ok: true, value: Object.freeze(entries) };
  } catch (error) {
    if (signal?.aborted === true || (error instanceof TarFault && error.kind === "cancelled")) {
      return acquisitionFailure("cancelled", "npm package acquisition was cancelled; resolve a new preview before retrying");
    }
    if (error instanceof TarFault && error.kind === "limit") {
      return acquisitionFailure("limit-exceeded", "The npm package exceeds portable archive limits; choose a smaller published package version");
    }
    return acquisitionFailure("invalid-archive", "The npm tarball is malformed, unsafe, or lacks the exact package/ wrapper; resolve the package again or choose another version");
  } finally {
    extract.destroy();
  }
}

export interface NpmAcquisitionProvenance {
  readonly adapter: "public-npm-tgz";
  readonly package: string;
  readonly requestedSelector: string;
  readonly version: string;
  readonly registryOrigin: typeof NPM_REGISTRY;
  readonly integrity: string;
  readonly reviewedMetadata: ReviewedHttpIdentity;
  readonly reviewedTarball: ReviewedHttpIdentity;
  readonly artifactDigest: Sha256;
  readonly treeDigest: Sha256;
  readonly rootDigest: Sha256;
  readonly selectedRoot: { readonly requested: "package/"; readonly path: ""; readonly usedSingleWrapper: true };
}

declare const evidenceBrand: unique symbol;
export interface NpmPluginAcquisitionEvidence {
  readonly [evidenceBrand]: true;
  readonly kind: "npm-plugin-acquisition";
  readonly source: NpmSource;
  readonly package: string;
  readonly requestedSelector: string;
  readonly version: string;
  readonly registryOrigin: typeof NPM_REGISTRY;
  readonly integrity: string;
  readonly artifactDigest: Sha256;
  readonly treeDigest: Sha256;
  readonly rootDigest: Sha256;
  readonly materialized: MaterializedPluginTree;
  readonly provenance: NpmAcquisitionProvenance;
}

const evidence = new WeakSet<NpmPluginAcquisitionEvidence>();
export function isNpmPluginAcquisitionEvidence(value: unknown): value is NpmPluginAcquisitionEvidence {
  return typeof value === "object" && value !== null && evidence.has(value as NpmPluginAcquisitionEvidence);
}

function sha256(bytes: Uint8Array): Sha256 {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function hasExactPackageIdentity(entries: readonly PluginTreeEntry[], packageName: string, version: string): boolean {
  const manifest = entries.find((entry) => entry.path === "package.json");
  if (manifest?.kind !== "file" || !(manifest.data instanceof Uint8Array)) return false;
  const value = parseBoundedJsonObject(manifest.data);
  return value !== undefined && value["name"] === packageName && typeof value["name"] === "string"
    && value["version"] === version && typeof value["version"] === "string" && semver.valid(value["version"]) === value["version"];
}

export async function acquireResolvedNpmPlugin(
  preview: ResolvedNpmPluginPreview,
  options: NpmAcquisitionOptions,
): Promise<AcquisitionResult<NpmPluginAcquisitionEvidence>> {
  const privateValue = previews.get(preview);
  if (privateValue === undefined) return acquisitionFailure("unsafe-source", "The npm preview is stale or already consumed; resolve the package again before retrying");
  // Consume confirmation before any I/O so every failure and cancellation makes replay inert.
  previews.delete(preview);
  let materialized: MaterializedPluginTree | undefined;
  try {
    const fetched = await fetchPublicHttps(preview.tarballUrl, {
      ...options,
      maximumBodyBytes: Math.min(options.maximumBodyBytes ?? ACQUISITION_LIMITS.maximumDownloadBytes, ACQUISITION_LIMITS.maximumDownloadBytes),
      maximumRedirects: 0,
    });
    if (!fetched.ok) {
      const redirected = redirectUnsupported(fetched, "tarball");
      const suffix = "Nothing was installed; this preview is consumed, so resolve a new exact-version preview before retrying";
      if (redirected !== undefined && !redirected.ok) {
        return acquisitionFailure(redirected.error.code, `${redirected.error.message}. ${suffix}`);
      }
      return acquisitionFailure(fetched.error.code, `${fetched.error.message}. ${suffix}`);
    }
    if (fetched.value.reviewed.origin !== NPM_REGISTRY || fetched.value.redirectCount !== 0) {
      return acquisitionFailure("unsafe-source", `npm tarball for ${preview.package}@${preview.version} must come directly from public ${NPM_REGISTRY}`);
    }
    const observedIntegrity = createHash("sha512").update(fetched.value.body).digest();
    if (!timingSafeEqual(observedIntegrity, privateValue.integrityDigest)) {
      return acquisitionFailure("integrity", `npm tarball for ${preview.package}@${preview.version} does not match the resolved SHA-512 integrity; resolve a new preview and retry`);
    }
    const parsed = await parseNpmPackageTree(fetched.value.body, options.signal);
    if (!parsed.ok) return parsed;
    if (!hasExactPackageIdentity(parsed.value, preview.package, preview.version)) {
      return acquisitionFailure("invalid-archive", `npm tarball must contain root package.json identifying exactly ${preview.package}@${preview.version}; resolve again or choose another version`);
    }
    const plan = validatePluginTree(parsed.value, { kind: "tree-root" });
    if (!plan.ok) return acquisitionFailure("invalid-archive", `npm package ${preview.package}@${preview.version} is not a portable tree; choose another version`);
    const staging = await issuePrivateStagingParent(options.store);
    if (!staging.ok) return acquisitionFailure("unsafe-source", `Private staging for ${preview.package}@${preview.version} is unavailable; repair lifecycle storage and retry with a new preview`);
    const made = await materializePluginTree(plan.value, staging.value);
    if (!made.ok) return acquisitionFailure("invalid-archive", `npm package ${preview.package}@${preview.version} could not be materialized safely; PiCC attempted cleanup, so use offline lifecycle recovery only if diagnostics report retained staging, then resolve a new preview`);
    materialized = made.value;
    if (options.postMaterializationWitness !== undefined) postMaterializationWitnesses.get(options.postMaterializationWitness)?.();
    if (options.signal?.aborted === true) {
      await discardMaterializedPluginTree(materialized);
      materialized = undefined;
      return acquisitionFailure("cancelled", `npm acquisition for ${preview.package}@${preview.version} was cancelled before evidence issuance; resolve a new preview to retry`);
    }
    const artifactDigest = sha256(fetched.value.body);
    const provenance: NpmAcquisitionProvenance = Object.freeze({
      adapter: "public-npm-tgz",
      package: preview.package,
      requestedSelector: preview.requestedSelector,
      version: preview.version,
      registryOrigin: NPM_REGISTRY,
      integrity: preview.integrity,
      reviewedMetadata: preview.reviewedMetadata,
      reviewedTarball: fetched.value.reviewed,
      artifactDigest,
      treeDigest: materialized.treeDigest,
      rootDigest: materialized.rootDigest,
      selectedRoot: Object.freeze({ requested: "package/", path: "", usedSingleWrapper: true }),
    });
    const result = Object.freeze({
      kind: "npm-plugin-acquisition",
      source: preview.source,
      package: preview.package,
      requestedSelector: preview.requestedSelector,
      version: preview.version,
      registryOrigin: NPM_REGISTRY,
      integrity: preview.integrity,
      artifactDigest,
      treeDigest: materialized.treeDigest,
      rootDigest: materialized.rootDigest,
      materialized,
      provenance,
    }) as NpmPluginAcquisitionEvidence;
    evidence.add(result);
    return { ok: true, value: result };
  } catch {
    if (materialized !== undefined) await discardMaterializedPluginTree(materialized);
    return options.signal?.aborted === true
      ? acquisitionFailure("cancelled", `npm acquisition for ${preview.package}@${preview.version} was cancelled; resolve a new preview to retry`)
      : acquisitionFailure("invalid-archive", `npm package ${preview.package}@${preview.version} could not be acquired safely; resolve a new preview and retry`);
  }
}

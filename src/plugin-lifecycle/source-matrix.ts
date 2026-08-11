import { isIP } from "node:net";
import path from "node:path";
import semver from "semver";
import {
  isDocumentedMarketplaceName,
  isSafeMarketplaceGithubRepo,
  isSafeMarketplaceRef,
} from "../util/plugin-marketplace-descriptor.js";
import { MAX_QUALIFIED_PLUGIN_ID_LENGTH, parseQualifiedPluginId } from "../util/plugin-id.js";
import { lifecycleError, type ContractResult } from "./errors.js";
import type {
  CatalogPluginSource,
  DefaultEnabledEvidence,
  InitialEnablementEvidence,
  MarketplaceRegistrationSource,
  MarketplaceSourceAdapter,
  PluginSourceAdapter,
  QualifiedPluginIdentity,
} from "./types.js";

const MAX_DESCRIPTOR_TEXT = 2048;
const NPM_PACKAGE = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const NPM_DIST_TAG = /^[A-Za-z][A-Za-z0-9._-]{0,63}$/;
const SHA = /^[0-9a-f]{40}$/i;
const SHA256 = /^[0-9a-f]{64}$/i;
const RESERVED_WINDOWS_SEGMENT = /^(?:con|prn|aux|nul|clock\$|conin\$|conout\$|com(?:[1-9]|[¹²³])|lpt(?:[1-9]|[¹²³]))(?:\..*)?$/i;
const NON_PUBLIC_DNS_SUFFIXES = new Set([
  "localhost", "local", "localdomain", "lan", "home", "internal", "alt", "test", "example", "invalid", "onion", "arpa",
]);

type ObjectValue = Record<string, unknown>;

export type MarketplaceRootRule =
  | "snapshot-directory-root"
  | "snapshot-catalog-parent"
  | "repository-root"
  | "descriptor-has-no-relative-root";

export type PluginRootRule =
  | "marketplace-generation-relative-subtree"
  | "repository-root"
  | "repository-declared-subdirectory"
  | "npm-package-directory"
  | "zip-root-or-single-wrapper";

export interface SourceRoute<T, A, R extends string> {
  readonly descriptor: T;
  readonly adapter: A;
  readonly rootRule: R;
}

export interface CatalogSourceContext {
  readonly marketplaceSourceKind: MarketplaceRegistrationSource["kind"];
  readonly metadataPluginRoot?: string;
}

type MatrixDescriptor = MarketplaceRegistrationSource | CatalogPluginSource;
type MatrixRoute =
  | SourceRoute<MarketplaceRegistrationSource, MarketplaceSourceAdapter, MarketplaceRootRule>
  | SourceRoute<CatalogPluginSource, PluginSourceAdapter, PluginRootRule>;

type SourceSurface = "marketplace" | "plugin";
type MatrixParser = (input: ObjectValue, context: CatalogSourceContext, surface: SourceSurface) => MatrixRoute | undefined;
type OwnMatrixParser = (input: ObjectValue, context: CatalogSourceContext) => MatrixDescriptor | undefined;

export interface SourceMatrixEntry {
  readonly surface: SourceSurface;
  readonly source: string;
  readonly adapter: MarketplaceSourceAdapter | PluginSourceAdapter;
  readonly rootRule: MarketplaceRootRule | PluginRootRule;
  readonly parse: MatrixParser;
}

function object(value: unknown): ObjectValue | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null ? value as ObjectValue : undefined;
}

function text(value: unknown, maximum = MAX_DESCRIPTOR_TEXT): string | undefined {
  return typeof value === "string"
    && value.length > 0
    && value.length <= maximum
    && !/[\u0000-\u001f\u007f]/.test(value)
    ? value
    : undefined;
}

function exact(value: ObjectValue, required: readonly string[], optional: readonly string[] = []): boolean {
  return required.every((key) => Object.hasOwn(value, key))
    && Object.keys(value).every((key) => required.includes(key) || optional.includes(key));
}

function safePortableSegment(segment: string): boolean {
  return segment.length > 0
    && segment !== "."
    && segment !== ".."
    && !/[<>:"|?*\u0000-\u001f]/.test(segment)
    && !/[. ]$/.test(segment)
    && !RESERVED_WINDOWS_SEGMENT.test(segment);
}

export function normalizePortableRelativePath(value: unknown): string | undefined {
  const candidate = text(value);
  if (candidate === undefined
    || candidate.startsWith("/")
    || candidate.startsWith("\\")
    || /^[A-Za-z]:/.test(candidate)
    || candidate.includes("\\")) return undefined;
  const segments = candidate.split("/");
  return segments.every(safePortableSegment) ? segments.join("/") : undefined;
}

function safeAbsolutePath(value: unknown): value is string {
  const candidate = text(value);
  if (candidate === undefined
    || candidate.startsWith("\\\\")
    || candidate.startsWith("//")
    || /^[\\/]\?\?[\\/]/.test(candidate)) return false;
  const api = /^[A-Za-z]:[\\/]/.test(candidate) ? path.win32 : path.posix;
  if (!api.isAbsolute(candidate)) return false;
  const root = api.parse(candidate).root;
  return candidate.slice(root.length).split(/[\\/]/).filter(Boolean).every(safePortableSegment);
}

function safeRef(value: unknown): string | undefined {
  const candidate = text(value, 256);
  return candidate !== undefined && isSafeMarketplaceRef(candidate) ? candidate : undefined;
}

function optionalRef(input: ObjectValue): { readonly ref?: string } | undefined {
  if (!Object.hasOwn(input, "ref")) return {};
  const ref = safeRef(input["ref"]);
  return ref === undefined ? undefined : { ref };
}

function optionalRevision(input: ObjectValue): { readonly ref?: string; readonly sha?: string } | undefined {
  const revision = optionalRef(input);
  if (revision === undefined) return undefined;
  if (!Object.hasOwn(input, "sha")) return revision;
  const sha = text(input["sha"], 40);
  return sha !== undefined && SHA.test(sha) ? { ...revision, sha: sha.toLowerCase() } : undefined;
}

function lexicalPublicDnsHost(hostname: string): boolean {
  const canonical = hostname.endsWith(".") ? hostname.slice(0, -1) : hostname;
  if (canonical.length === 0 || canonical.length > 253 || isIP(canonical) !== 0) return false;
  const labels = canonical.toLowerCase().split(".");
  const topLevel = labels.at(-1)!;
  const validLabel = (label: string): boolean => label.length <= 63
    && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label);
  return labels.length >= 2
    && !NON_PUBLIC_DNS_SUFFIXES.has(topLevel)
    && labels.every(validLabel)
    && (/^[a-z]{2,63}$/.test(topLevel) || /^xn--[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(topLevel));
}

function publicHttps(value: unknown): string | undefined {
  const candidate = text(value);
  if (candidate === undefined) return undefined;
  try {
    const parsed = new URL(candidate);
    const hostname = parsed.hostname.replace(/^\[|\]$/g, "");
    const authority = candidate.slice(candidate.indexOf("://") + 3).split(/[/?#]/, 1)[0] ?? "";
    if (parsed.protocol !== "https:"
      || authority.includes("@")
      || candidate.includes("?")
      || candidate.includes("#")
      || parsed.username
      || parsed.password
      || !lexicalPublicDnsHost(hostname)) return undefined;
    return candidate;
  } catch {
    return undefined;
  }
}

function safeNpmSelector(value: unknown): string | undefined {
  const candidate = text(value, 256);
  if (candidate === undefined) return undefined;
  return semver.valid(candidate) !== null
    || semver.validRange(candidate) !== null
    || NPM_DIST_TAG.test(candidate)
    ? candidate
    : undefined;
}

function route<T, A, R extends string>(descriptor: T, adapter: A, rootRule: R): SourceRoute<T, A, R> {
  return Object.freeze({ descriptor: Object.freeze(descriptor) as T, adapter, rootRule });
}

function matrixEntry(
  entry: Omit<SourceMatrixEntry, "parse"> & { readonly parseOwn: OwnMatrixParser },
): SourceMatrixEntry {
  const { parseOwn, ...publicEntry } = entry;
  return {
    ...publicEntry,
    parse: (input, context, surface) => {
      if (surface !== entry.surface || input["source"] !== entry.source) return undefined;
      const descriptor = parseOwn(input, context);
      return descriptor === undefined
        ? undefined
        : route(descriptor, entry.adapter, entry.rootRule) as MatrixRoute;
    },
  };
}

const entries: SourceMatrixEntry[] = [
  matrixEntry({ surface: "marketplace", source: "directory", adapter: "local-directory-snapshot", rootRule: "snapshot-directory-root", parseOwn: (input) => {
    const value = input["path"];
    return safeAbsolutePath(value) && exact(input, ["source", "path"])
      ? { kind: "local-directory", path: value }
      : undefined;
  } }),
  matrixEntry({ surface: "marketplace", source: "file", adapter: "local-catalog-snapshot", rootRule: "snapshot-catalog-parent", parseOwn: (input) => {
    const value = input["path"];
    return safeAbsolutePath(value) && exact(input, ["source", "path"])
      ? { kind: "local-catalog-file", path: value }
      : undefined;
  } }),
  matrixEntry({ surface: "marketplace", source: "github", adapter: "anonymous-https-git", rootRule: "repository-root", parseOwn: (input) => {
    const repository = text(input["repo"], 256);
    const revision = optionalRef(input);
    return repository !== undefined
      && isSafeMarketplaceGithubRepo(repository)
      && revision !== undefined
      && exact(input, ["source", "repo"], ["ref"])
      ? { kind: "github", repository, ...revision }
      : undefined;
  } }),
  matrixEntry({ surface: "marketplace", source: "git", adapter: "anonymous-https-git", rootRule: "repository-root", parseOwn: (input) => {
    const url = publicHttps(input["url"]);
    const revision = optionalRef(input);
    return url !== undefined && revision !== undefined && exact(input, ["source", "url"], ["ref"])
      ? { kind: "https-git", url, ...revision }
      : undefined;
  } }),
  matrixEntry({ surface: "marketplace", source: "url", adapter: "public-https-catalog", rootRule: "descriptor-has-no-relative-root", parseOwn: (input) => {
    const url = publicHttps(input["url"]);
    return url !== undefined && exact(input, ["source", "url"])
      ? { kind: "https-catalog", url }
      : undefined;
  } }),
  matrixEntry({ surface: "plugin", source: "relative", adapter: "marketplace-relative-tree", rootRule: "marketplace-generation-relative-subtree", parseOwn: (input, context) => {
    const value = text(input["path"]);
    if (value === undefined
      || !exact(input, ["source", "path"])
      || context.marketplaceSourceKind === "https-catalog") return undefined;
    const hasDotPrefix = value.startsWith("./");
    const sourcePath = normalizePortableRelativePath(hasDotPrefix ? value.slice(2) : value);
    const rawPluginRoot = context.metadataPluginRoot;
    const pluginRoot = rawPluginRoot === undefined
      ? undefined
      : normalizePortableRelativePath(rawPluginRoot.startsWith("./") ? rawPluginRoot.slice(2) : rawPluginRoot);
    return sourcePath !== undefined
      && (rawPluginRoot === undefined || pluginRoot !== undefined)
      && (hasDotPrefix || pluginRoot !== undefined)
      ? { kind: "relative", path: sourcePath, ...(pluginRoot === undefined ? {} : { pluginRoot }) }
      : undefined;
  } }),
  matrixEntry({ surface: "plugin", source: "github", adapter: "anonymous-https-git", rootRule: "repository-root", parseOwn: (input) => {
    const repository = text(input["repo"], 256);
    const revision = optionalRevision(input);
    return repository !== undefined
      && isSafeMarketplaceGithubRepo(repository)
      && revision !== undefined
      && exact(input, ["source", "repo"], ["ref", "sha"])
      ? { kind: "github", repository, ...revision }
      : undefined;
  } }),
  matrixEntry({ surface: "plugin", source: "url", adapter: "anonymous-https-git", rootRule: "repository-root", parseOwn: (input) => {
    const url = publicHttps(input["url"]);
    const revision = optionalRevision(input);
    return url !== undefined && revision !== undefined && exact(input, ["source", "url"], ["ref", "sha"])
      ? { kind: "https-git", url, ...revision }
      : undefined;
  } }),
  matrixEntry({ surface: "plugin", source: "git-subdir", adapter: "anonymous-https-git-subdir", rootRule: "repository-declared-subdirectory", parseOwn: (input) => {
    const url = publicHttps(input["url"]);
    const sourcePath = normalizePortableRelativePath(input["path"]);
    const revision = optionalRevision(input);
    return url !== undefined
      && sourcePath !== undefined
      && revision !== undefined
      && exact(input, ["source", "url", "path"], ["ref", "sha"])
      ? { kind: "https-git-subdir", url, path: sourcePath, ...revision }
      : undefined;
  } }),
  matrixEntry({ surface: "plugin", source: "npm", adapter: "public-npm-tgz", rootRule: "npm-package-directory", parseOwn: (input) => {
    const packageName = text(input["package"], 214);
    const version = Object.hasOwn(input, "version") ? safeNpmSelector(input["version"]) : undefined;
    const registry = Object.hasOwn(input, "registry") ? input["registry"] : "https://registry.npmjs.org";
    return packageName !== undefined
      && NPM_PACKAGE.test(packageName)
      && (!Object.hasOwn(input, "version") || version !== undefined)
      && registry === "https://registry.npmjs.org"
      && exact(input, ["source", "package"], ["version", "registry"])
      ? { kind: "npm", package: packageName, ...(version === undefined ? {} : { version }), registry: "https://registry.npmjs.org" as const }
      : undefined;
  } }),
  matrixEntry({ surface: "plugin", source: "archive", adapter: "public-https-zip", rootRule: "zip-root-or-single-wrapper", parseOwn: (input) => {
    const url = publicHttps(input["url"]);
    const digest = Object.hasOwn(input, "sha256") ? text(input["sha256"], 64) : undefined;
    return url !== undefined
      && (!Object.hasOwn(input, "sha256") || (digest !== undefined && SHA256.test(digest)))
      && exact(input, ["source", "url"], ["sha256"])
      ? { kind: "https-zip", url, ...(digest === undefined ? {} : { sha256: digest.toLowerCase() }) }
      : undefined;
  } }),
];

export const SOURCE_MATRIX: readonly SourceMatrixEntry[] = Object.freeze(
  entries.map((entry) => Object.freeze(entry)),
);

function parseObjectSource<T, A, R extends string>(
  surface: SourceSurface,
  input: unknown,
  context: CatalogSourceContext,
): ContractResult<SourceRoute<T, A, R>> {
  const value = object(input);
  if (value === undefined || typeof value["source"] !== "string") {
    return lifecycleError("unsupported-source", `Unsupported ${surface} source descriptor`);
  }
  const entry = SOURCE_MATRIX.find((candidate) => candidate.surface === surface && candidate.source === value["source"]);
  if (entry === undefined) return lifecycleError("unsupported-source", `Unsupported ${surface} source family`);
  const parsed = entry.parse(value, context, surface);
  return parsed === undefined
    ? lifecycleError("unsafe-descriptor", `Invalid or unsafe ${surface} source descriptor`)
    : { ok: true, value: parsed as SourceRoute<T, A, R> };
}

export function routeMarketplaceSource(
  input: unknown,
): ContractResult<SourceRoute<MarketplaceRegistrationSource, MarketplaceSourceAdapter, MarketplaceRootRule>> {
  return parseObjectSource("marketplace", input, { marketplaceSourceKind: "local-directory" });
}

export function routeCatalogPluginSource(
  input: unknown,
  context: CatalogSourceContext,
): ContractResult<SourceRoute<CatalogPluginSource, PluginSourceAdapter, PluginRootRule>> {
  const matrixInput = typeof input === "string" ? { source: "relative", path: input } : input;
  const result = parseObjectSource<CatalogPluginSource, PluginSourceAdapter, PluginRootRule>(
    "plugin",
    matrixInput,
    context,
  );
  if (!result.ok && typeof input === "string") {
    return context.marketplaceSourceKind === "https-catalog"
      ? lifecycleError("relative-source-unavailable", "HTTPS catalog descriptors cannot resolve relative plugin sources")
      : lifecycleError("invalid-relative-path", "Relative plugin source requires ./ or a portable metadata.pluginRoot");
  }
  return result;
}

export function qualifiedPluginIdentity(name: string, marketplace: string): ContractResult<QualifiedPluginIdentity> {
  const candidate = `${name}@${marketplace}`;
  const parsed = parseQualifiedPluginId(candidate, MAX_QUALIFIED_PLUGIN_ID_LENGTH);
  return parsed !== undefined
    && parsed.lifecycleName === name
    && isDocumentedMarketplaceName(parsed.marketplaceName)
    ? { ok: true, value: candidate as QualifiedPluginIdentity }
    : lifecycleError("invalid-identity", "Plugin identity must use the bounded documented qualified identity grammar");
}

export function resolveInitialEnablement(evidence: InitialEnablementEvidence): boolean {
  for (const candidate of [evidence.existingEffective, evidence.marketplaceDefault, evidence.manifestDefault]) {
    if (candidate.presence === "explicit") return candidate.value;
  }
  return true;
}

export function explicitDefault(value: boolean): DefaultEnabledEvidence {
  return Object.freeze({ presence: "explicit", value });
}

export const ABSENT_DEFAULT: DefaultEnabledEvidence = Object.freeze({ presence: "absent" });

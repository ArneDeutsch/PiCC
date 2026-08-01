import fs from "node:fs";
import path from "node:path";
import type {
  ClaudeSettings,
  Diagnostic,
  PluginInstallationScope,
  PluginMarketplaceCatalogEntry,
  PluginMarketplaceCatalogObservation,
  PluginMarketplaceComponentDeclaration,
  PluginMarketplaceComponentField,
  PluginMarketplaceDependency,
  PluginMarketplaceFieldProvenance,
  PluginMarketplacePolicyDescriptor,
  PluginMarketplacePolicyObservation,
  PluginMarketplaceProvenance,
  PluginMarketplaceRegistration,
  PluginMarketplaceRegistrationSource,
  PluginMarketplaceCatalogSource,
  PluginMarketplaceRename,
  PluginMarketplaceSafeShape,
  PluginMarketplaceSettingsContribution,
  PluginMarketplaceState,
  Scope,
} from "../types.js";
import { stripBom } from "../util/fs.js";
import {
  extractMarketplaceSourceHost,
  isSafeMarketplaceGitLocation,
  isSafeMarketplaceGithubRepo,
  isSafeMarketplaceRef,
  normalizeMarketplacePolicyDescriptor,
  normalizeMarketplaceRegistrationRecord,
  parseSupportedMarketplacePattern,
  supportedMarketplacePatternMatches,
} from "../util/plugin-marketplace-descriptor.js";

const KNOWN_MARKETPLACES_FILE = "known_marketplaces.json";
const CATALOG_RELATIVE = path.join(".claude-plugin", "marketplace.json");
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_NESTING = 32;
const MAX_REGISTRATIONS = 256;
const MAX_SELECTED = 256;
const MAX_ENTRIES = 1024;
const MAX_COMPONENTS = 1024;
const MAX_DEPENDENCIES = 1024;
const MAX_RENAMES = 512;
const MAX_POLICIES = 256;
const MAX_ALLOWLISTS = 256;
const MAX_METADATA = 256;
const MAX_USER_CONFIG = 256;
const MAX_USER_CONFIG_KEYS = 256;
const MAX_CONFLICTS = 256;
const MAX_SEMANTIC_INDEX = 2048;
const MAX_DIAGNOSTICS = 128;
const MAX_SEED_ROOTS = 32;
const MAX_STRING = 4096;
const MAX_NAME = 128;
const MARKETPLACE_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const NPM_PACKAGE_SEGMENT = /^[a-z0-9!~*'()-][a-z0-9!~*'()._-]*$/;
const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|clock\$|com[1-9]|lpt[1-9])(?:\..*)?$/i;
const marketplaceRootBrand: unique symbol = Symbol("ValidatedMarketplaceRoot");

interface ValidatedMarketplaceRoot {
  lexicalPath: string;
  canonicalPath: string;
  readonly [marketplaceRootBrand]: true;
}

interface Candidate {
  name: string;
  source: PluginMarketplaceRegistrationSource;
  comparison: string;
  provenance: PluginMarketplaceProvenance;
  fixtureContract?: "fixture-derived-unverified";
  validity: PluginMarketplaceRegistration["validity"];
  indeterminate?: "credential-bearing-or-ambiguous";
  root?: () => ValidatedMarketplaceRoot | undefined;
  catalog?: () => string | undefined;
  materialized?: PluginMarketplaceRegistration;
}

interface ParsedDescriptor<T> {
  display: T;
  comparison: string;
}

export interface PluginMarketplaceSettingsInputContribution extends Omit<PluginMarketplaceSettingsContribution, "extraKnownMarketplaces" | "strictKnownMarketplaces" | "blockedMarketplaces"> {
  extraKnownMarketplaces?: Record<string, unknown>;
  strictKnownMarketplaces?: unknown[];
  blockedMarketplaces?: unknown[];
}

export interface LoadPluginMarketplaceStateOptions {
  userDir: string;
  projectRoot: string;
  settings?: {
    pluginMarketplaceSettings?: readonly PluginMarketplaceSettingsInputContribution[];
    pluginMarketplaceSettingsOmissions?: ClaudeSettings["pluginMarketplaceSettingsOmissions"];
  };
  seedDirs?: readonly string[];
  env?: NodeJS.ProcessEnv;
}

function plain(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function own(object: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(object, key) ? object[key] : undefined;
}

function text(value: unknown, maximum = MAX_STRING): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= maximum && !/[\u0000-\u001f\u007f]/.test(value)
    ? value
    : undefined;
}

function name(value: unknown): string | undefined {
  const candidate = text(value, MAX_NAME);
  return candidate !== undefined && MARKETPLACE_NAME.test(candidate) && !WINDOWS_RESERVED.test(candidate)
    ? candidate
    : undefined;
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function nestingTooDeep(source: string): boolean {
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (const character of source) {
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quoted = false;
    } else if (character === '"') quoted = true;
    else if (character === "{" || character === "[") {
      if (++depth > MAX_NESTING) return true;
    } else if (character === "}" || character === "]") depth--;
  }
  return false;
}

function readJsonBounded(filePath: string): { status: "absent" | "invalid" | "valid"; value?: unknown } {
  let descriptor: number;
  try {
    descriptor = fs.openSync(filePath, "r");
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? { status: "absent" } : { status: "invalid" };
  }
  let result: { status: "invalid" | "valid"; value?: unknown } = { status: "invalid" };
  try {
    const bytes = Buffer.allocUnsafe(MAX_FILE_BYTES + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const consumed = fs.readSync(descriptor, bytes, offset, bytes.length - offset, null);
      if (consumed === 0) break;
      offset += consumed;
    }
    if (offset <= MAX_FILE_BYTES) {
      const source = stripBom(bytes.subarray(0, offset).toString("utf8"));
      if (!nestingTooDeep(source)) {
        try {
          result = { status: "valid", value: JSON.parse(source) as unknown };
        } catch {
          result = { status: "invalid" };
        }
      }
    }
  } catch {
    result = { status: "invalid" };
  }
  try {
    fs.closeSync(descriptor);
  } catch {
    return { status: "invalid" };
  }
  return result;
}

function contained(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

function portableRelative(value: string): boolean {
  if (value.length === 0 || value.length > MAX_STRING || value.startsWith("/") || value.startsWith("\\") || /^[A-Za-z]:/.test(value) || /^(?:\\\\|\/\/)/.test(value)) return false;
  const parts = value.replaceAll("\\", "/").replace(/^\.\//, "").split("/");
  return !parts.some((part) => part === "" || part === "." || part === ".." || part.includes(":") || /[<>"|?*\u0000-\u001f]/.test(part) || /[. ]$/.test(part) || WINDOWS_RESERVED.test(part));
}

function safeComponentPath(value: unknown): value is string {
  return typeof value === "string" && value.startsWith("./") && !/[\\?#]/.test(value) && portableRelative(value);
}

function nativeAbsolute(value: string): boolean {
  if (process.platform === "win32") return /^[A-Za-z]:[\\/]/.test(value) && !/^[\\/]{2}[?.][\\/]/.test(value);
  return value.startsWith("/") && !value.startsWith("//") && !value.startsWith("/\\");
}

function canonicalDirectory(value: string): string | undefined {
  try {
    const canonical = fs.realpathSync.native(value);
    return fs.statSync(canonical).isDirectory() ? canonical : undefined;
  } catch {
    return undefined;
  }
}

function structurallyValidCommonGitDirectory(gitDirectory: string): boolean {
  try {
    return path.basename(gitDirectory) === ".git" && fs.statSync(path.join(gitDirectory, "HEAD")).isFile() &&
      fs.statSync(path.join(gitDirectory, "config")).isFile() && fs.statSync(path.join(gitDirectory, "objects")).isDirectory() &&
      fs.statSync(path.join(gitDirectory, "refs")).isDirectory();
  } catch {
    return false;
  }
}

function mainCheckout(projectRoot: string): string | undefined {
  const canonicalProject = canonicalDirectory(projectRoot);
  if (canonicalProject === undefined) return undefined;
  const dotGit = path.join(canonicalProject, ".git");
  try {
    if (fs.statSync(dotGit).isDirectory()) {
      const canonicalGit = fs.realpathSync.native(dotGit);
      return structurallyValidCommonGitDirectory(canonicalGit) ? canonicalProject : undefined;
    }
    if (!fs.statSync(dotGit).isFile()) return undefined;
    const match = /^gitdir:\s*(.+)$/i.exec(fs.readFileSync(dotGit, "utf8").trim());
    if (match === null) return undefined;
    const admin = canonicalDirectory(path.resolve(canonicalProject, match[1]!));
    if (admin === undefined || path.basename(path.dirname(admin)) !== "worktrees") return undefined;
    const backlink = fs.readFileSync(path.join(admin, "gitdir"), "utf8").trim();
    if (path.basename(backlink) !== ".git" || fs.realpathSync.native(path.dirname(backlink)) !== canonicalProject) return undefined;
    const common = fs.realpathSync.native(path.resolve(admin, fs.readFileSync(path.join(admin, "commondir"), "utf8").trim()));
    if (!structurallyValidCommonGitDirectory(common)) return undefined;
    const expectedAdminParent = fs.realpathSync.native(path.join(common, "worktrees"));
    if (fs.realpathSync.native(path.dirname(admin)) !== expectedAdminParent || path.dirname(admin) === admin) return undefined;
    const main = fs.realpathSync.native(path.dirname(common));
    return fs.realpathSync.native(path.join(main, ".git")) === common ? main : undefined;
  } catch {
    return undefined;
  }
}

function validateRoot(value: string): ValidatedMarketplaceRoot | undefined {
  if (!nativeAbsolute(value) || value.length > MAX_STRING || /[\u0000-\u001f]/.test(value)) return undefined;
  const lexicalPath = path.normalize(value);
  const canonicalPath = canonicalDirectory(lexicalPath);
  return canonicalPath === undefined ? undefined : { lexicalPath, canonicalPath, [marketplaceRootBrand]: true };
}

function catalogPath(root: ValidatedMarketplaceRoot): string | undefined {
  const lexical = path.join(root.lexicalPath, CATALOG_RELATIVE);
  try {
    const canonical = fs.realpathSync.native(lexical);
    return contained(root.canonicalPath, canonical) && fs.statSync(canonical).isFile() ? lexical : undefined;
  } catch {
    return undefined;
  }
}

function containedDirectory(root: ValidatedMarketplaceRoot, ...segments: string[]): ValidatedMarketplaceRoot | undefined {
  const candidate = validateRoot(path.join(root.lexicalPath, ...segments));
  return candidate !== undefined && contained(root.canonicalPath, candidate.canonicalPath) ? candidate : undefined;
}

function containedFile(root: ValidatedMarketplaceRoot, ...segments: string[]): string | undefined {
  const lexical = path.join(root.lexicalPath, ...segments);
  try {
    const canonical = fs.realpathSync.native(lexical);
    return contained(root.canonicalPath, canonical) && fs.statSync(canonical).isFile() ? lexical : undefined;
  } catch {
    return undefined;
  }
}

function normalizedScope(scope: Scope): PluginInstallationScope {
  return scope === "managed" || scope === "local" || scope === "project" ? scope : "user";
}

function safeOption(value: unknown, maximum = 256): string | undefined {
  const candidate = text(value, maximum);
  return candidate !== undefined && /^[A-Za-z0-9^<>=*~][A-Za-z0-9._+~^<>=*| -]*$/.test(candidate) &&
    !candidate.includes("..") && !candidate.includes("//") ? candidate : undefined;
}

function safeNpmPackage(value: string): boolean {
  if (value.length > 214) return false;
  const scoped = value.startsWith("@");
  const segments = (scoped ? value.slice(1) : value).split("/");
  return segments.length === (scoped ? 2 : 1) && segments.every((segment) => NPM_PACKAGE_SEGMENT.test(segment));
}

function safeRegistry(value: string): boolean {
  if (!/^https?:\/\//i.test(value) || /[\\\s]/.test(value)) return false;
  try {
    const parsed = new URL(value);
    return (parsed.protocol === "http:" || parsed.protocol === "https:") && parsed.host !== "" && parsed.username === "" &&
      parsed.password === "" && parsed.search === "" && parsed.hash === "";
  } catch { return false; }
}

function exactKeys(raw: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(raw).every((key) => keys.includes(key));
}

function registrationDescriptor(rawRecord: unknown, scope?: Scope): (ParsedDescriptor<PluginMarketplaceRegistrationSource> & { validity: "valid" | "rejected"; indeterminate?: "credential-bearing-or-ambiguous" }) | undefined {
  const observation = normalizeMarketplaceRegistrationRecord(rawRecord, scope);
  const descriptor = observation.descriptor;
  if (descriptor === undefined || descriptor.kind === "hostPattern" || descriptor.kind === "pathPattern") return undefined;
  return { display: descriptor, comparison: observation.matchKey ?? "", validity: observation.validity === "valid" ? "valid" : "rejected", ...(observation.indeterminate === "credential-bearing-or-ambiguous" ? { indeterminate: observation.indeterminate } : {}) };
}

function catalogDescriptor(raw: unknown, pluginRoot?: string): PluginMarketplaceCatalogSource | undefined {
  if (typeof raw === "string") {
    const value = text(raw);
    return value !== undefined && portableRelative(value) && (value.startsWith("./") || pluginRoot !== undefined) ? { kind: "relative", value } : undefined;
  }
  if (!plain(raw)) return undefined;
  const kind = own(raw, "source");
  const ref = own(raw, "ref") === undefined ? undefined : text(own(raw, "ref"), 256);
  const sha = own(raw, "sha") === undefined ? undefined : text(own(raw, "sha"), 40);
  const revisionOptionsValid = (ref === undefined ? own(raw, "ref") === undefined : isSafeMarketplaceRef(ref)) &&
    (sha === undefined ? own(raw, "sha") === undefined : /^[0-9a-fA-F]{40}$/.test(sha));
  if (kind === "github") {
    const repo = text(own(raw, "repo"), 256);
    return repo !== undefined && isSafeMarketplaceGithubRepo(repo) && exactKeys(raw, ["source", "repo", "ref", "sha"]) && revisionOptionsValid
      ? { kind, repo, ...(ref === undefined ? {} : { ref }), ...(sha === undefined ? {} : { sha }) } : undefined;
  }
  if (kind === "url") {
    const url = text(own(raw, "url"));
    return url !== undefined && isSafeMarketplaceGitLocation(url) && exactKeys(raw, ["source", "url", "ref", "sha"]) && revisionOptionsValid
      ? { kind, url, ...(ref === undefined ? {} : { ref }), ...(sha === undefined ? {} : { sha }) } : undefined;
  }
  if (kind === "git-subdir") {
    const url = text(own(raw, "url"));
    const declaredPath = text(own(raw, "path"));
    return url !== undefined && (isSafeMarketplaceGitLocation(url) || isSafeMarketplaceGithubRepo(url)) && declaredPath !== undefined && portableRelative(declaredPath) && exactKeys(raw, ["source", "url", "path", "ref", "sha"]) && revisionOptionsValid
      ? { kind, url, path: declaredPath, ...(ref === undefined ? {} : { ref }), ...(sha === undefined ? {} : { sha }) } : undefined;
  }
  if (kind === "npm") {
    const packageName = text(own(raw, "package"), 256);
    const version = own(raw, "version") === undefined ? undefined : safeOption(own(raw, "version"));
    const registry = own(raw, "registry") === undefined ? undefined : text(own(raw, "registry"));
    const optionsValid = (version !== undefined || own(raw, "version") === undefined) &&
      (registry === undefined ? own(raw, "registry") === undefined : safeRegistry(registry));
    return packageName !== undefined && safeNpmPackage(packageName) && exactKeys(raw, ["source", "package", "version", "registry"]) && optionsValid
      ? { kind, package: packageName, ...(version === undefined ? {} : { version }), ...(registry === undefined ? {} : { registry }) } : undefined;
  }
  return undefined;
}

function policyDescriptor(raw: unknown): { parsed?: ParsedDescriptor<PluginMarketplacePolicyDescriptor>; observation: ReturnType<typeof normalizeMarketplacePolicyDescriptor> } {
  const observation = normalizeMarketplacePolicyDescriptor(raw);
  return {
    observation,
    ...(observation.validity === "valid" && observation.descriptor !== undefined && observation.matchKey !== undefined
      ? { parsed: { display: observation.descriptor, comparison: observation.matchKey } }
      : {}),
  };
}

function descriptorMatches(policy: ParsedDescriptor<PluginMarketplacePolicyDescriptor>, selected: Candidate): boolean {
  if (policy.display.kind === "hostPattern") {
    const host = extractMarketplaceSourceHost(selected.source);
    const pattern = parseSupportedMarketplacePattern(policy.display.hostPattern);
    return host !== undefined && pattern !== undefined && supportedMarketplacePatternMatches(pattern, host);
  }
  if (policy.display.kind === "pathPattern") {
    const target = selected.source.kind === "directory" || selected.source.kind === "file" ? selected.source.path : undefined;
    const pattern = parseSupportedMarketplacePattern(policy.display.pathPattern);
    return target !== undefined && pattern !== undefined && supportedMarketplacePatternMatches(pattern, target);
  }
  return policy.comparison === selected.comparison;
}

function resolveSettingsRoot(source: PluginMarketplaceRegistrationSource, scope: Scope, anchor: string | undefined): ValidatedMarketplaceRoot | undefined {
  const declared = "localPath" in source ? source.localPath : undefined;
  if (declared === undefined || source.kind === "file") return undefined;
  if (scope === "project" || scope === "local") {
    if (!portableRelative(declared) || anchor === undefined) return undefined;
    const anchorCanonical = canonicalDirectory(anchor);
    if (anchorCanonical === undefined) return undefined;
    const candidate = path.resolve(anchorCanonical, declared.replaceAll("/", path.sep).replaceAll("\\", path.sep));
    const root = validateRoot(candidate);
    return root !== undefined && contained(anchorCanonical, root.canonicalPath) ? root : undefined;
  }
  return validateRoot(declared);
}

function resolveSettingsFile(source: PluginMarketplaceRegistrationSource, scope: Scope, anchor: string | undefined): string | undefined {
  if (source.kind !== "file") return undefined;
  const declared = source.localPath;
  let lexical: string;
  let containmentRoot: string;
  if (scope === "project" || scope === "local") {
    if (!portableRelative(declared) || anchor === undefined) return undefined;
    const canonicalAnchor = canonicalDirectory(anchor);
    if (canonicalAnchor === undefined) return undefined;
    containmentRoot = canonicalAnchor;
    lexical = path.resolve(canonicalAnchor, declared.replaceAll("/", path.sep).replaceAll("\\", path.sep));
  } else {
    if (!nativeAbsolute(declared)) return undefined;
    lexical = path.normalize(declared);
    containmentRoot = path.dirname(lexical);
  }
  try {
    const canonical = fs.realpathSync.native(lexical);
    const canonicalContainment = fs.realpathSync.native(containmentRoot);
    return contained(canonicalContainment, canonical) && fs.statSync(canonical).isFile() ? lexical : undefined;
  } catch {
    return undefined;
  }
}

function provenance(scope: PluginInstallationScope, sourcePath: string, origin: PluginMarketplaceProvenance["origin"], order: number): PluginMarketplaceProvenance {
  return { scope, sourcePath, origin, order };
}

function fieldProvenance(registration: PluginMarketplaceRegistration, entryIndex: number | undefined, field: string, itemIndex?: number, key?: string): PluginMarketplaceFieldProvenance {
  return { field, sourcePath: registration.catalogPath!, ...(entryIndex === undefined ? {} : { entryIndex }), ...(key === undefined ? {} : { key }), ...(itemIndex === undefined ? {} : { itemIndex }) };
}

interface SemanticBudget {
  allowlists: number;
  entries: number;
  renames: number;
}

function valueType(value: unknown): "array" | "boolean" | "null" | "number" | "object" | "string" {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value === "boolean" ? "boolean" : typeof value === "number" ? "number" : typeof value === "string" ? "string" : "object";
}

function safeShape(raw: Record<string, unknown>, maximum: number): PluginMarketplaceSafeShape {
  const keys = Object.keys(raw).sort(compare);
  return {
    keys: keys.slice(0, maximum).map((key) => ({ key: /^[A-Za-z][A-Za-z0-9_.-]{0,127}$/.test(key) ? key : "<redacted-key>", type: valueType(own(raw, key)) })),
    omitted: Math.max(0, keys.length - maximum),
  };
}

function parseCatalog(registration: PluginMarketplaceRegistration, state: PluginMarketplaceState, semantic: SemanticBudget, report: (message: string, source?: string) => void): void {
  if (registration.catalogPath === undefined) return;
  const loaded = readJsonBounded(registration.catalogPath);
  if (loaded.status !== "valid" || !plain(loaded.value)) {
    if (loaded.status !== "absent") report("Marketplace catalog is malformed or exceeds a safe bound", registration.catalogPath);
    return;
  }
  const catalogName = name(own(loaded.value, "name"));
  const owner = own(loaded.value, "owner");
  if (catalogName === undefined || catalogName !== registration.name || !plain(owner) || text(own(owner, "name"), 256) === undefined) {
    report(catalogName !== registration.name ? "Marketplace registration key disagrees with the catalog name; catalog ignored" : "Marketplace catalog requires owner.name; catalog ignored", registration.catalogPath);
    return;
  }
  const plugins = own(loaded.value, "plugins");
  if (!Array.isArray(plugins)) { report("Marketplace catalog plugins field is not an array; catalog ignored", registration.catalogPath); return; }
  let catalogPluginRoot: string | undefined;
  let catalogMetadata: PluginMarketplaceCatalogObservation["metadata"];
  const metadataRaw = own(loaded.value, "metadata");
  if (metadataRaw !== undefined) {
    const pluginRootRaw = plain(metadataRaw) ? own(metadataRaw, "pluginRoot") : undefined;
    const pluginRoot = text(pluginRootRaw);
    if (pluginRoot !== undefined && portableRelative(pluginRoot)) {
      catalogPluginRoot = pluginRoot;
      if (state.catalogs.filter((catalog) => catalog.metadata !== undefined).length < MAX_METADATA) catalogMetadata = { pluginRoot, provenance: fieldProvenance(registration, undefined, "metadata.pluginRoot"), posture: "inert-lexical-effect-only" };
      else state.omissions.metadata++;
    } else report("Marketplace catalog metadata.pluginRoot is invalid; ignored", registration.catalogPath);
  }
  state.catalogs.push({ marketplace: registration.name, catalogPath: registration.catalogPath, ...(catalogMetadata === undefined ? {} : { metadata: catalogMetadata }), provenance: registration.provenance });
  const allowRaw = own(loaded.value, "allowCrossMarketplaceDependenciesOn");
  const allowed = new Set<string>();
  let allowEvidenceOmitted = false;
  if (allowRaw !== undefined && !Array.isArray(allowRaw)) report("Marketplace cross-dependency allowlist has the wrong type; ignored", registration.catalogPath);
  if (Array.isArray(allowRaw)) {
    for (let allowIndex = 0; allowIndex < allowRaw.length; allowIndex++) {
      const allowedName = name(allowRaw[allowIndex]);
      if (allowedName === undefined) { report("Marketplace cross-dependency allowlist contains a malformed declaration", registration.catalogPath); continue; }
      if (semantic.allowlists < MAX_SEMANTIC_INDEX) { semantic.allowlists++; allowed.add(allowedName); }
      else allowEvidenceOmitted = true;
      if (state.allowlists.length >= MAX_ALLOWLISTS) { state.omissions.allowlists++; continue; }
      state.allowlists.push({ marketplace: registration.name, allowedMarketplace: allowedName, provenance: fieldProvenance(registration, undefined, "allowCrossMarketplaceDependenciesOn", allowIndex) });
    }
  }
  const seenIdentities = new Map(state.entries.map((entry) => [entry.identity, fieldProvenance(registration, entry.provenance.entryIndex, "name")]));
  const knownEntryNames = new Set<string>();
  let entryEvidenceOmitted = false;
  let retainedComponentCount = state.entries.reduce((sum, entry) => sum + Object.values(entry.components).reduce((inner, list) => inner + list.length, 0), 0);
  let retainedUserConfigKeys = state.entries.reduce((sum, entry) => sum + (entry.userConfig?.keys.length ?? 0), 0);
  for (let index = 0; index < plugins.length; index++) {
    const raw = plugins[index];
    if (!plain(raw)) { report("Marketplace catalog contains a malformed plugin entry", registration.catalogPath); continue; }
    const pluginName = name(own(raw, "name"));
    if (pluginName === undefined) { report("Marketplace catalog contains an invalid documented plugin name", registration.catalogPath); continue; }
    const identity = `${pluginName}@${registration.name}`;
    const winner = seenIdentities.get(identity);
    if (winner !== undefined) {
      const loser = fieldProvenance(registration, index, "name");
      if (state.conflicts.length < MAX_CONFLICTS) state.conflicts.push({ identity, winner, loser, posture: "observed-conflict-not-effective" });
      else state.omissions.conflicts++;
      report(`Marketplace catalog duplicate conflict for ${identity}: entry ${winner.entryIndex} wins over entry ${index}`, registration.catalogPath);
      continue;
    }
    const rawSource = own(raw, "source");
    const source = catalogDescriptor(rawSource, catalogPluginRoot);
    if (source === undefined) { report("Catalog plugin source descriptor is missing, malformed, or undocumented; entry ignored", registration.catalogPath); continue; }
    seenIdentities.set(identity, fieldProvenance(registration, index, "name"));
    if (semantic.entries < MAX_SEMANTIC_INDEX) { semantic.entries++; knownEntryNames.add(pluginName); }
    else entryEvidenceOmitted = true;
    if (state.entries.length >= MAX_ENTRIES) { state.omissions.entries++; continue; }

    const components: Partial<Record<PluginMarketplaceComponentField, PluginMarketplaceComponentDeclaration[]>> = Object.create(null);
    const retainComponent = (key: PluginMarketplaceComponentField, item: unknown, itemIndex?: number, allowObject = false): void => {
      let declaration: PluginMarketplaceComponentDeclaration | undefined;
      const itemProvenance = fieldProvenance(registration, index, key, itemIndex);
      if (safeComponentPath(item)) declaration = { kind: "path", value: item, provenance: itemProvenance, posture: "declared-not-effective" };
      else if (allowObject && plain(item)) declaration = { kind: "object-shape", shape: safeShape(item, 32), provenance: itemProvenance, posture: "declared-not-effective" };
      else report(`Catalog plugin ${key} declaration item is malformed or not a portable ./ plugin-root-relative path; ignored`, registration.catalogPath);
      if (declaration === undefined) return;
      if (retainedComponentCount >= MAX_COMPONENTS) { state.omissions.components++; return; }
      (components[key] ??= []).push(declaration);
      retainedComponentCount++;
    };
    for (const key of ["commands", "agents", "skills"] as const) {
      const value = own(raw, key);
      if (value === undefined) continue;
      if (Array.isArray(value)) value.forEach((item, itemIndex) => retainComponent(key, item, itemIndex));
      else retainComponent(key, value);
    }
    for (const key of ["hooks", "mcpServers", "lspServers"] as const) {
      const value = own(raw, key);
      if (value === undefined) continue;
      if (Array.isArray(value)) value.forEach((item, itemIndex) => retainComponent(key, item, itemIndex, true));
      else retainComponent(key, value, undefined, true);
    }

    const dependencies: PluginMarketplaceDependency[] = [];
    const dependencyRaw = own(raw, "dependencies");
    if (dependencyRaw !== undefined && !Array.isArray(dependencyRaw)) report("Catalog plugin dependencies have the wrong type; declaration ignored", registration.catalogPath);
    if (Array.isArray(dependencyRaw)) for (let dependencyIndex = 0; dependencyIndex < dependencyRaw.length; dependencyIndex++) {
      const item = dependencyRaw[dependencyIndex];
      if (state.dependencies.length >= MAX_DEPENDENCIES) { state.omissions.dependencies++; continue; }
      let dependencyName: string | undefined;
      let targetMarketplace: string | undefined = registration.name;
      let version: string | undefined;
      if (typeof item === "string") dependencyName = name(item);
      else if (plain(item) && exactKeys(item, ["name", "version", "marketplace"])) {
        dependencyName = name(own(item, "name"));
        if (own(item, "marketplace") !== undefined) targetMarketplace = name(own(item, "marketplace"));
        if (own(item, "version") !== undefined) version = safeOption(own(item, "version"));
        if ((own(item, "marketplace") !== undefined && targetMarketplace === undefined) || (own(item, "version") !== undefined && version === undefined)) dependencyName = undefined;
      }
      if (dependencyName === undefined || targetMarketplace === undefined) { report("Catalog plugin contains a malformed dependency declaration", registration.catalogPath); continue; }
      const dependency: PluginMarketplaceDependency = {
        declaredName: dependencyName,
        declaringIdentity: identity,
        targetIdentity: `${dependencyName}@${targetMarketplace}`,
        marketplace: targetMarketplace,
        ...(version === undefined ? {} : { version, versionStatus: "syntax-unverified-not-resolved" as const }),
        provenance: fieldProvenance(registration, index, "dependencies", dependencyIndex),
        crossMarketplace: targetMarketplace === registration.name ? "same-marketplace" : allowed.has(targetMarketplace) ? "declared-allowed" : allowEvidenceOmitted ? "indeterminate-because-evidence-omitted" : "declared-not-allowed",
        posture: "declared-locally-observable-not-resolved",
      };
      dependencies.push(dependency);
      state.dependencies.push(dependency);
    }

    const version = own(raw, "version") === undefined ? undefined : safeOption(own(raw, "version"));
    const revision = own(raw, "revision") === undefined ? undefined : safeOption(own(raw, "revision"));
    if (own(raw, "version") !== undefined && version === undefined) report("Catalog plugin version is invalid; ignored", registration.catalogPath);
    if (own(raw, "revision") !== undefined && revision === undefined) report("Catalog plugin revision is invalid; ignored", registration.catalogPath);
    if (version !== undefined && revision !== undefined) report("Catalog plugin declares both version and revision; version is selected", registration.catalogPath);
    const sourceSha = "sha" in source ? source.sha : undefined;
    const release = version !== undefined
      ? { kind: "version" as const, value: version, provenance: fieldProvenance(registration, index, "version") }
      : revision !== undefined
        ? { kind: "revision" as const, value: revision, provenance: fieldProvenance(registration, index, "revision") }
        : sourceSha !== undefined
          ? { kind: "source-sha" as const, value: sourceSha, provenance: fieldProvenance(registration, index, "source.sha") }
          : undefined;
    const strictRaw = own(raw, "strict");
    const strict = typeof strictRaw === "boolean" ? strictRaw : true;
    if (strictRaw !== undefined && typeof strictRaw !== "boolean") report("Catalog plugin strict declaration has the wrong type; defaulted to true", registration.catalogPath);
    const defaultRaw = own(raw, "defaultEnabled");
    const defaultEnabled = typeof defaultRaw === "boolean" ? defaultRaw : true;
    if (defaultRaw !== undefined && typeof defaultRaw !== "boolean") report("Catalog plugin defaultEnabled declaration has the wrong type; defaulted to true", registration.catalogPath);
    const descriptionRaw = own(raw, "description");
    const description = descriptionRaw === undefined ? undefined : text(descriptionRaw);
    if (descriptionRaw !== undefined && description === undefined) report("Catalog plugin description is invalid; ignored", registration.catalogPath);

    let userConfig: PluginMarketplaceCatalogEntry["userConfig"];
    const configRaw = own(raw, "userConfig");
    if (configRaw !== undefined) {
      if (!plain(configRaw)) report("Catalog plugin userConfig has the wrong type; values ignored", registration.catalogPath);
      else if (state.entries.filter((entry) => entry.userConfig !== undefined).length >= MAX_USER_CONFIG) state.omissions.userConfig++;
      else {
        const maximum = Math.min(32, Math.max(0, MAX_USER_CONFIG_KEYS - retainedUserConfigKeys));
        const summary = safeShape(configRaw, maximum);
        retainedUserConfigKeys += summary.keys.length;
        userConfig = { ...summary, provenance: fieldProvenance(registration, index, "userConfig") };
      }
    }

    const sourceProvenance = fieldProvenance(registration, index, "source");
    const fieldEvidence: Record<string, PluginMarketplaceFieldProvenance> = { source: sourceProvenance, strict: fieldProvenance(registration, index, "strict"), defaultEnabled: fieldProvenance(registration, index, "defaultEnabled") };
    if (description !== undefined) fieldEvidence.description = fieldProvenance(registration, index, "description");
    if (version !== undefined) fieldEvidence.version = fieldProvenance(registration, index, "version");
    if (revision !== undefined) fieldEvidence.revision = fieldProvenance(registration, index, "revision");
    if (sourceSha !== undefined) fieldEvidence["source.sha"] = fieldProvenance(registration, index, "source.sha");
    const sourceEffect = source.kind === "relative" ? {
      availability: registration.source.kind === "url" ? "unavailable-from-direct-url-catalog" as const : "locally-observable" as const,
      lexicalPath: path.posix.join(catalogPluginRoot ?? ".", source.value),
      provenance: sourceProvenance,
    } : undefined;
    const entry: PluginMarketplaceCatalogEntry = {
      identity, name: pluginName, marketplace: registration.name, source, ...(sourceEffect === undefined ? {} : { sourceEffect }),
      ...(release === undefined ? {} : { release: release.kind === "revision" ? { ...release, evidence: "fixture-derived-unverified" as const } : release }),
      ...(version === undefined ? {} : { version }), ...(revision === undefined ? {} : { revision, revisionEvidence: "fixture-derived-unverified" as const }),
      ...(description === undefined ? {} : { description }), fieldProvenance: fieldEvidence, strict,
      strictDeclaration: { value: strict, presence: typeof strictRaw === "boolean" ? "explicit" : "default", provenance: fieldEvidence.strict! },
      defaultEnabled,
      defaultEnabledDeclaration: { value: defaultEnabled, presence: typeof defaultRaw === "boolean" ? "explicit" : "default", provenance: fieldEvidence.defaultEnabled! },
      components, dependencies, ...(userConfig === undefined ? {} : { userConfig }),
      provenance: { ...registration.provenance, catalogPath: registration.catalogPath, entryIndex: index }, runtimeEffect: "declared-not-effective",
    };
    state.entries.push(entry);
  }
  parseRenames(own(loaded.value, "renames"), registration, state, semantic, knownEntryNames, entryEvidenceOmitted, report);
}

function parseRenames(raw: unknown, registration: PluginMarketplaceRegistration, state: PluginMarketplaceState, semantic: SemanticBudget, known: ReadonlySet<string>, entryEvidenceOmitted: boolean, report: (message: string, source?: string) => void): void {
  if (raw === undefined) return;
  if (!plain(raw)) { report("Marketplace catalog renames field is not an object; ignored", registration.catalogPath); return; }
  const declarations = new Map<string, string | null>();
  const retainedFrom: string[] = [];
  let renameEvidenceOmitted = false;
  for (const oldName of Object.keys(raw).sort(compare)) {
    const from = name(oldName);
    const value = own(raw, oldName);
    const target = value === null ? null : name(value);
    if (from === undefined || (value !== null && target === undefined)) { report("Marketplace catalog contains a malformed rename declaration", registration.catalogPath); continue; }
    if (semantic.renames < MAX_SEMANTIC_INDEX) { semantic.renames++; declarations.set(from, target!); }
    else renameEvidenceOmitted = true;
    if (state.renames.length + retainedFrom.length < MAX_RENAMES) retainedFrom.push(from);
    else state.omissions.renames++;
  }
  for (const from of retainedFrom) {
    if (!declarations.has(from)) continue;
    const declaredTarget = declarations.get(from) as string | null;
    let current = declaredTarget;
    let status: PluginMarketplaceRename["status"] = current === null ? "removed" : "current";
    const seen = new Set<string>([from]);
    while (current !== null && declarations.has(current)) {
      if (seen.has(current)) { status = "cycle"; break; }
      seen.add(current);
      current = declarations.get(current)!;
      if (current === null) status = "removed";
    }
    if (status === "current" && current !== null && !known.has(current)) status = entryEvidenceOmitted || renameEvidenceOmitted ? "indeterminate-because-evidence-omitted" : "dangling";
    state.renames.push({ marketplace: registration.name, from, declaredTarget, currentIdentity: status === "current" && current !== null ? `${current}@${registration.name}` : null, status, fieldProvenance: fieldProvenance(registration, undefined, "renames", undefined, from), provenance: { ...registration.provenance, catalogPath: registration.catalogPath! }, runtimeEffect: "declared-not-effective" });
    if (status === "cycle" || status === "dangling") report(`Marketplace rename is ${status}; declaration is inert`, registration.catalogPath);
  }
}

/**
 * Observe allowlisted local marketplace state without refreshing it. The
 * `known_marketplaces.json` serialization is fixture-derived, not an upstream API.
 */
export function loadPluginMarketplaceState(options: LoadPluginMarketplaceStateOptions): PluginMarketplaceState {
  const state: PluginMarketplaceState = {
    registrations: [], selectedRegistrations: [], catalogs: [], entries: [], dependencies: [], allowlists: [], renames: [], policies: [], conflicts: [], diagnostics: [],
    omissions: { registrations: 0, selectedRegistrations: 0, entries: 0, components: 0, dependencies: 0, renames: 0, policies: 0, allowlists: 0, metadata: 0, userConfig: 0, conflicts: 0, diagnostics: 0 },
  };
  const report = (message: string, source?: string): void => {
    if (state.diagnostics.length < MAX_DIAGNOSTICS) state.diagnostics.push({ severity: "warning", message, ...(source === undefined ? {} : { source }) });
    else state.omissions.diagnostics++;
  };
  let order = 0;
  const evidence: Candidate[] = [];
  const selected = new Map<string, Candidate>();
  let selectedSemanticOmitted = (options.settings?.pluginMarketplaceSettingsOmissions?.declarations ?? 0) > 0 || (options.settings?.pluginMarketplaceSettingsOmissions?.contributions ?? 0) > 0;
  const settingsByName = new Map<string, Candidate[]>();
  const select = (candidate: Candidate): void => {
    if (selected.has(candidate.name) || selected.size < MAX_SEMANTIC_INDEX) selected.set(candidate.name, candidate);
    else { selectedSemanticOmitted = true; state.omissions.selectedRegistrations++; }
  };
  const materialize = (candidate: Candidate, selectedFlag: boolean): PluginMarketplaceRegistration => {
    const root = candidate.root?.();
    const pathToCatalog = candidate.catalog?.() ?? (root === undefined ? undefined : catalogPath(root));
    const localResolverFailed = candidate.catalog !== undefined ? pathToCatalog === undefined : candidate.root !== undefined && root === undefined;
    const validity = candidate.validity === "valid" && "localPath" in candidate.source && localResolverFailed ? "rejected" : candidate.validity;
    if (candidate.validity === "valid" && validity === "rejected") report("Local marketplace source failed canonical containment or existence validation", candidate.provenance.sourcePath);
    return {
      name: candidate.name, source: candidate.source,
      sourceProvenance: { field: "source", sourcePath: candidate.provenance.sourcePath, key: candidate.name },
      provenance: candidate.provenance, ...(candidate.fixtureContract === undefined ? {} : { fixtureContract: candidate.fixtureContract }),
      ...(pathToCatalog === undefined ? {} : { catalogPath: pathToCatalog }), selected: selectedFlag, validity,
    };
  };
  const retainEvidence = (candidate: Candidate): void => {
    if (evidence.length < MAX_REGISTRATIONS) evidence.push(candidate);
    else state.omissions.registrations++;
  };
  const addCandidate = (candidate: Candidate): void => {
    candidate.materialized = materialize(candidate, false);
    candidate.validity = candidate.materialized.validity;
    retainEvidence(candidate);
    if (candidate.validity !== "valid") return;
    if (candidate.provenance.origin === "seed") {
      const current = selected.get(candidate.name);
      if (current === undefined || current.provenance.origin === "primary") select(candidate);
    } else if (candidate.provenance.origin === "primary" && !selected.has(candidate.name)) select(candidate);
    else if (candidate.provenance.origin === "settings") {
      const list = settingsByName.get(candidate.name) ?? [];
      list.push(candidate);
      settingsByName.set(candidate.name, list);
    }
  };
  const loadRegistrationFile = (filePath: string, origin: "primary" | "seed", rootFor: (marketplace: string) => ValidatedMarketplaceRoot | undefined): void => {
    const loaded = readJsonBounded(filePath);
    if (loaded.status === "absent") return;
    if (loaded.status !== "valid" || !plain(loaded.value)) { report("Known marketplace registration file is malformed or exceeds a safe bound", filePath); return; }
    for (const key of Object.keys(loaded.value).sort(compare)) {
      const marketplaceName = name(key);
      if (marketplaceName === undefined) { report("Known marketplace registration contains an invalid documented name", filePath); continue; }
      const record = own(loaded.value, key);
      const parsed = registrationDescriptor(record);
      if (parsed === undefined) { report("Known marketplace registration entry has a malformed nested source descriptor", filePath); continue; }
      addCandidate({ name: marketplaceName, source: parsed.display, comparison: parsed.comparison, provenance: provenance("user", filePath, origin, order++), fixtureContract: "fixture-derived-unverified", validity: parsed.validity, ...(parsed.indeterminate === undefined ? {} : { indeterminate: parsed.indeterminate }), ...(parsed.validity === "valid" ? { root: () => rootFor(marketplaceName) } : {}) });
      if (parsed.validity === "rejected") report("Known marketplace registration descriptor was redacted and retained as inert evidence", filePath);
    }
  };

  const canonicalUser = validateRoot(options.userDir);
  const primaryPath = canonicalUser === undefined ? undefined : containedFile(canonicalUser, "plugins", KNOWN_MARKETPLACES_FILE);
  const userBase = canonicalUser === undefined ? undefined : containedDirectory(canonicalUser, "plugins", "marketplaces");
  if (primaryPath !== undefined) loadRegistrationFile(primaryPath, "primary", (marketplace) => userBase === undefined ? undefined : containedDirectory(userBase, marketplace));

  const configuredSeeds = options.seedDirs ?? (options.env ?? process.env).CLAUDE_CODE_PLUGIN_SEED_DIR?.split(path.delimiter) ?? [];
  for (const seedValue of configuredSeeds.slice(0, MAX_SEED_ROOTS)) {
    const seed = validateRoot(seedValue);
    if (seed === undefined) { report("Plugin seed directory is invalid or unreadable; ignored"); continue; }
    const registrationPath = containedFile(seed, KNOWN_MARKETPLACES_FILE);
    if (registrationPath === undefined) continue;
    loadRegistrationFile(registrationPath, "seed", (marketplace) => containedDirectory(seed, marketplace) ?? containedDirectory(seed, "marketplaces", marketplace));
  }
  if (configuredSeeds.length > MAX_SEED_ROOTS) report("Additional plugin seed directories omitted after the safe limit");

  const anchor = mainCheckout(options.projectRoot);
  for (const contribution of options.settings?.pluginMarketplaceSettings ?? []) {
    if (contribution.extraKnownMarketplaces === undefined) continue;
    for (const key of Object.keys(contribution.extraKnownMarketplaces).sort(compare)) {
      const marketplaceName = name(key);
      const raw = contribution.extraKnownMarketplaces[key];
      const parsed = registrationDescriptor(raw, contribution.scope);
      if (marketplaceName === undefined || parsed === undefined) { report("extraKnownMarketplaces contains an invalid name or nested source descriptor", contribution.sourcePath); continue; }
      const source = parsed.display;
      const hasLocalPath = "localPath" in source;
      const lexicallyRejected = hasLocalPath && (contribution.scope === "project" || contribution.scope === "local") && !portableRelative(source.localPath);
      const candidate: Candidate = {
        name: marketplaceName, source, comparison: parsed.comparison, provenance: provenance(normalizedScope(contribution.scope), contribution.sourcePath, "settings", order++),
        validity: parsed.validity === "rejected" || lexicallyRejected ? "rejected" : "valid",
        ...(parsed.indeterminate === undefined ? {} : { indeterminate: parsed.indeterminate }),
        ...(parsed.validity === "valid" && hasLocalPath && !lexicallyRejected ? source.kind === "file"
          ? { catalog: () => resolveSettingsFile(source, contribution.scope, anchor) }
          : { root: () => resolveSettingsRoot(source, contribution.scope, anchor) } : {}),
      };
      addCandidate(candidate);
      if (lexicallyRejected) report("Local marketplace source failed scope-sensitive path validation and was not probed", contribution.sourcePath);
      else if (parsed.validity === "rejected") report("Marketplace source descriptor was redacted and retained as inert evidence", contribution.sourcePath);
    }
  }
  for (const [marketplaceName, candidates] of settingsByName) if (!selected.has(marketplaceName) && candidates.length > 0) select(candidates.at(-1)!);

  const selectedCandidates = [...selected.values()].sort((left, right) => compare(left.name, right.name));
  const redactedRegistrationEvidence = evidence.some((candidate) => candidate.indeterminate !== undefined);
  const selectedObservations = selectedCandidates.map((candidate) => ({ ...candidate.materialized!, selected: true }));
  for (const observation of selectedObservations) {
    if (state.selectedRegistrations.length >= MAX_SELECTED) { state.omissions.selectedRegistrations++; continue; }
    state.selectedRegistrations.push(observation);
  }
  const selectedOrders = new Set(selectedCandidates.map((candidate) => candidate.provenance.order));
  for (const candidate of evidence) state.registrations.push({ ...candidate.materialized!, selected: selectedOrders.has(candidate.provenance.order) });

  for (const contribution of options.settings?.pluginMarketplaceSettings ?? []) {
    for (const [key, kind] of [["strictKnownMarketplaces", "strict"], ["blockedMarketplaces", "blocked"]] as const) {
      const declarations = contribution[key];
      if (declarations === undefined) continue;
      const validScope = contribution.scope === "managed";
      if (declarations.length === 0 && kind === "strict") {
        if (state.policies.length < MAX_POLICIES) state.policies.push({ kind, provenance: provenance(normalizedScope(contribution.scope), contribution.sourcePath, "settings", order++), validScope, match: false, emptyLockdown: true, posture: "claude-lifecycle-observation-not-enforced" });
        else state.omissions.policies++;
      }
      for (let declarationIndex = 0; declarationIndex < declarations.length; declarationIndex++) {
        const raw = declarations[declarationIndex];
        if (state.policies.length >= MAX_POLICIES) { state.omissions.policies++; continue; }
        const normalized = policyDescriptor(raw);
        const definiteMatch = normalized.parsed !== undefined && validScope && selectedCandidates.some((candidate) => candidate.validity === "valid" && descriptorMatches(normalized.parsed!, candidate));
        const matched: PluginMarketplacePolicyObservation["match"] = !validScope ? false
          : definiteMatch ? true
          : normalized.observation.indeterminate === "unsupported-regex-subset" ? "indeterminate-unsupported-regex-subset"
          : normalized.observation.indeterminate !== undefined ? "indeterminate-redacted-descriptor"
          : normalized.parsed !== undefined && redactedRegistrationEvidence ? "indeterminate-redacted-descriptor"
          : normalized.parsed !== undefined && selectedSemanticOmitted ? "indeterminate-because-evidence-omitted"
          : false;
        state.policies.push({ kind, ...(normalized.observation.descriptor === undefined ? {} : { descriptor: normalized.observation.descriptor, descriptorProvenance: { field: key, sourcePath: contribution.sourcePath, itemIndex: declarationIndex } }), provenance: provenance(normalizedScope(contribution.scope), contribution.sourcePath, "settings", order++), validScope, match: matched, posture: "claude-lifecycle-observation-not-enforced" });
        if (normalized.observation.validity !== "valid") report(`${key} contains a malformed or unsafe source descriptor (including redacted or unsupported forms)`, contribution.sourcePath);
        else if (!validScope) report(`${key} is outside its documented managed scope and is inert`, contribution.sourcePath);
      }
    }
  }

  const semantic: SemanticBudget = { allowlists: 0, entries: 0, renames: 0 };
  for (const registration of state.selectedRegistrations) if (registration.validity === "valid") parseCatalog(registration, state, semantic, report);
  state.registrations.sort((left, right) => compare(left.name, right.name) || left.provenance.order - right.provenance.order);
  state.entries.sort((left, right) => compare(left.identity, right.identity));
  state.dependencies.sort((left, right) => compare(left.declaringIdentity, right.declaringIdentity) || compare(left.targetIdentity, right.targetIdentity));
  state.renames.sort((left, right) => compare(left.marketplace, right.marketplace) || compare(left.from, right.from));
  state.diagnostics.sort((left: Diagnostic, right: Diagnostic) => compare(left.source ?? "", right.source ?? "") || compare(left.message, right.message));
  return state;
}

import { constants, promises as fs, type BigIntStats } from "node:fs";
import path from "node:path";
import { digestArtifactEntries, type ArtifactDigestEntry } from "./artifact-digest.js";
import { lifecycleError, type ContractResult } from "./errors.js";
import { selectPluginRoot, type PluginRootRequest, type PluginRootSelection } from "./plugin-root.js";
import type { Sha256 } from "./types.js";

export const PORTABLE_TREE_LIMITS = Object.freeze({
  maximumDepth: 32,
  maximumEntries: 10_000,
  maximumFileBytes: 8 * 1024 * 1024,
  maximumPathBytes: 1024,
  maximumTotalBytes: 16 * 1024 * 1024,
});

export type PluginTreeEntryKind = "directory" | "file" | "symlink" | "hardlink" | "junction" | "special";

export interface PluginTreeEntry {
  readonly path: string;
  readonly kind: PluginTreeEntryKind;
  readonly data?: Uint8Array;
  readonly executable?: boolean;
  readonly target?: string;
  readonly sparse?: boolean;
}

declare const validatedTreeBrand: unique symbol;
export interface ValidatedPluginTree {
  readonly [validatedTreeBrand]: true;
}

declare const stagingParentBrand: unique symbol;
export interface PrivateStagingParent {
  readonly [stagingParentBrand]: true;
}

declare const materializedTreeBrand: unique symbol;
export interface MaterializedPluginTree {
  readonly [materializedTreeBrand]: true;
  readonly stagingDirectory: string;
  readonly pluginRoot: string;
  readonly treeDigest: Sha256;
  readonly rootDigest: Sha256;
  readonly rootSelection: PluginRootSelection;
  readonly entryCount: number;
  readonly fileCount: number;
  readonly totalBytes: number;
}

interface ValidatedTreeDetails {
  readonly entries: readonly ArtifactDigestEntry[];
  readonly rootSelection: PluginRootSelection;
  readonly treeDigest: Sha256;
  readonly rootDigest: Sha256;
  readonly fileCount: number;
  readonly totalBytes: number;
}

interface Identity {
  readonly dev: bigint;
  readonly ino: bigint;
}

interface BoundComponent {
  readonly path: string;
  readonly identity: Identity;
}

interface StagingAuthority {
  readonly canonicalPath: string;
  readonly components: readonly BoundComponent[];
}

const plans = new WeakMap<ValidatedPluginTree, ValidatedTreeDetails>();
const stagingAuthorities = new WeakMap<PrivateStagingParent, StagingAuthority>();
const materializedAuthorities = new WeakMap<MaterializedPluginTree, { readonly staging: string; readonly identity: Identity }>();
const ENTRY_KEYS = new Set(["path", "kind", "data", "executable", "target", "sparse"]);
const WINDOWS_DEVICE = /^(?:con|prn|aux|nul|clock\$|conin\$|conout\$|com(?:[1-9]|[¹²³])|lpt(?:[1-9]|[¹²³]))(?:\..*)?$/i;
const INVALID_PATH_CHARACTER = /[\\<>:"|?*]|[\p{Cc}\p{Cf}]/u;

function invalidTree(message: string): ContractResult<ValidatedPluginTree> {
  return lifecycleError("unsafe-descriptor", message);
}

function identity(stat: BigIntStats): Identity {
  return { dev: stat.dev, ino: stat.ino };
}

function sameIdentity(left: Identity, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameCanonicalPath(left: string, right: string): boolean {
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

async function ordinaryDirectory(directory: string): Promise<BigIntStats> {
  const stat = await fs.lstat(directory, { bigint: true });
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("not an ordinary directory");
  return stat;
}

async function captureOrdinaryPath(candidate: string): Promise<StagingAuthority> {
  const resolved = path.resolve(candidate);
  const parsed = path.parse(resolved);
  const components: BoundComponent[] = [];
  let current = parsed.root;
  for (const segment of resolved.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    components.push({ path: current, identity: identity(await ordinaryDirectory(current)) });
  }
  const canonicalPath = await fs.realpath(resolved);
  if (!sameCanonicalPath(canonicalPath, resolved)) throw new Error("staging parent is aliased");
  if (components.length === 0) components.push({ path: resolved, identity: identity(await ordinaryDirectory(resolved)) });
  return { canonicalPath: resolved, components: Object.freeze(components) };
}

async function revalidateAuthority(authority: StagingAuthority): Promise<void> {
  for (const component of authority.components) {
    if (!sameIdentity(component.identity, await ordinaryDirectory(component.path))) {
      throw new Error("staging authority identity changed");
    }
  }
  const canonical = await fs.realpath(authority.canonicalPath);
  if (!sameCanonicalPath(canonical, authority.canonicalPath)) throw new Error("staging authority became aliased");
}

// This binder establishes identity, not trust or privacy. The owned-store layer is the sole production issuer.
export async function bindPrivateStagingParentForTrustedCode(
  candidate: string,
): Promise<ContractResult<PrivateStagingParent>> {
  try {
    if (typeof candidate !== "string" || candidate.length === 0) throw new Error("invalid staging parent");
    const authority = await captureOrdinaryPath(candidate);
    const capability = Object.freeze({}) as PrivateStagingParent;
    stagingAuthorities.set(capability, authority);
    return { ok: true, value: capability };
  } catch {
    return lifecycleError("unsafe-descriptor", "Private staging parent identity could not be bound");
  }
}

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function normalizeEntryPath(value: unknown): string | undefined {
  if (typeof value !== "string"
    || value.length === 0
    || hasUnpairedSurrogate(value)
    || value.startsWith("/")
    || value.startsWith("\\")
    || /^[A-Za-z]:/.test(value)
    || INVALID_PATH_CHARACTER.test(value)) return undefined;
  const segments = value.split("/");
  if (segments.some((segment) => segment.length === 0
    || segment === "."
    || segment === ".."
    || /[. ]$/.test(segment)
    || WINDOWS_DEVICE.test(segment))) return undefined;
  return segments.join("/");
}

function ancestors(entryPath: string): string[] {
  const segments = entryPath.split("/");
  return segments.slice(1).map((_, index) => segments.slice(0, index + 1).join("/"));
}

function conservativeCaseFold(value: string): string {
  // Lower/upper expansion catches multi-code-point folds such as ß, ẞ, and SS.
  return value.toLowerCase().toUpperCase().toLowerCase();
}

function aliasKeys(entryPath: string): readonly string[] {
  return [
    `windows:${conservativeCaseFold(entryPath.normalize("NFC"))}`,
    `macos:${conservativeCaseFold(entryPath.normalize("NFD"))}`,
  ];
}

function inspectPlainRecord(value: unknown, allowedKeys: ReadonlySet<string>): PropertyDescriptorMap | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const prototype = Object.getPrototypeOf(value);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if ((prototype !== Object.prototype && prototype !== null)
    || Object.getOwnPropertySymbols(value).length > 0
    || Object.keys(descriptors).some((key) => !allowedKeys.has(key))
    || Object.values(descriptors).some((descriptor) => descriptor.get !== undefined || descriptor.set !== undefined)) return undefined;
  return descriptors;
}

function descriptorValue(descriptors: PropertyDescriptorMap, key: string): unknown {
  return descriptors[key]?.value;
}

function validatePluginTreeUnchecked(
  inputEntries: readonly PluginTreeEntry[],
  rootRequest: PluginRootRequest,
): ContractResult<ValidatedPluginTree> {
  if (!Array.isArray(inputEntries) || inputEntries.length === 0) return invalidTree("Plugin tree must contain at least one entry");
  if (inputEntries.length > PORTABLE_TREE_LIMITS.maximumEntries) return invalidTree("Plugin tree exceeds the entry-count limit");

  const explicit = new Map<string, ArtifactDigestEntry>();
  const aliases = new Map<string, string>();
  let fileCount = 0;
  let totalBytes = 0;

  for (const raw of inputEntries) {
    const descriptors = inspectPlainRecord(raw, ENTRY_KEYS);
    if (descriptors === undefined) return invalidTree("Plugin tree contains unsafe entry metadata");
    const entryPath = normalizeEntryPath(descriptorValue(descriptors, "path"));
    if (entryPath === undefined
      || Buffer.byteLength(entryPath, "utf8") > PORTABLE_TREE_LIMITS.maximumPathBytes
      || entryPath.split("/").length > PORTABLE_TREE_LIMITS.maximumDepth) {
      return invalidTree("Plugin tree contains an unsafe or excessive path");
    }
    if (explicit.has(entryPath)) return invalidTree("Plugin tree contains a duplicate path");
    for (const key of aliasKeys(entryPath)) {
      const existing = aliases.get(key);
      if (existing !== undefined && existing !== entryPath) return invalidTree("Plugin tree contains a case or Unicode-normalization collision");
      aliases.set(key, entryPath);
    }

    const kind = descriptorValue(descriptors, "kind");
    const data = descriptorValue(descriptors, "data");
    const executable = descriptorValue(descriptors, "executable");
    const target = descriptorValue(descriptors, "target");
    const sparse = descriptorValue(descriptors, "sparse");
    if (kind !== "directory" && kind !== "file") return invalidTree("Plugin tree contains a link or special entry");
    if (sparse !== undefined || target !== undefined) return invalidTree("Plugin tree contains unsupported entry metadata");
    if (kind === "directory") {
      if (data !== undefined || executable !== undefined) return invalidTree("Plugin tree contains invalid directory metadata");
      explicit.set(entryPath, Object.freeze({ path: entryPath, kind: "directory" }));
      continue;
    }
    if (!(data instanceof Uint8Array)
      || (typeof SharedArrayBuffer !== "undefined" && data.buffer instanceof SharedArrayBuffer)
      || (executable !== undefined && typeof executable !== "boolean")) {
      return invalidTree("Plugin tree contains invalid file metadata");
    }
    if (data.byteLength > PORTABLE_TREE_LIMITS.maximumFileBytes) return invalidTree("Plugin tree contains an excessive file");
    totalBytes += data.byteLength;
    if (totalBytes > PORTABLE_TREE_LIMITS.maximumTotalBytes) return invalidTree("Plugin tree exceeds the total-byte limit");
    fileCount += 1;
    explicit.set(entryPath, Object.freeze({
      path: entryPath,
      kind: "file",
      executable: executable === true,
      data: Uint8Array.from(data),
    }));
  }

  const complete = new Map(explicit);
  for (const entryPath of explicit.keys()) {
    for (const ancestor of ancestors(entryPath)) {
      const existing = complete.get(ancestor);
      if (existing?.kind === "file") return invalidTree("Plugin tree contains a file/directory prefix conflict");
      if (existing === undefined) complete.set(ancestor, Object.freeze({ path: ancestor, kind: "directory" }));
    }
  }
  if (complete.size > PORTABLE_TREE_LIMITS.maximumEntries) return invalidTree("Plugin tree exceeds the materialized entry-count limit");

  const completeAliases = new Map<string, string>();
  for (const entryPath of complete.keys()) {
    for (const key of aliasKeys(entryPath)) {
      const existing = completeAliases.get(key);
      if (existing !== undefined && existing !== entryPath) return invalidTree("Plugin tree contains an implicit case or Unicode-normalization collision");
      completeAliases.set(key, entryPath);
    }
  }

  const selection = selectPluginRoot(new Map([...complete].map(([entryPath, entry]) => [entryPath, entry.kind])), rootRequest);
  if (!selection.ok) return invalidTree(selection.reason);
  const entries = Object.freeze([...complete.values()].sort((left, right) => Buffer.compare(Buffer.from(left.path), Buffer.from(right.path))));
  const details: ValidatedTreeDetails = Object.freeze({
    entries,
    rootSelection: selection.value,
    treeDigest: digestArtifactEntries(entries),
    rootDigest: digestArtifactEntries(entries, selection.value.path),
    fileCount,
    totalBytes,
  });
  const plan = Object.freeze({}) as ValidatedPluginTree;
  plans.set(plan, details);
  return { ok: true, value: plan };
}

export function validatePluginTree(
  inputEntries: readonly PluginTreeEntry[],
  rootRequest: PluginRootRequest,
): ContractResult<ValidatedPluginTree> {
  try {
    return validatePluginTreeUnchecked(inputEntries, rootRequest);
  } catch {
    return invalidTree("Plugin tree metadata could not be safely inspected");
  }
}

function nativePath(root: string, relative: string): string {
  return path.join(root, ...relative.split("/"));
}

async function removeIfStillOwned(staging: string, stagingIdentity: Identity | undefined): Promise<void> {
  if (stagingIdentity === undefined) return;
  try {
    const stat = await ordinaryDirectory(staging);
    if (sameIdentity(stagingIdentity, stat)) await fs.rm(staging, { recursive: true, force: true });
  } catch {
    // Changed or unreadable identity is retained as inactive quarantine.
  }
}

async function createTree(staging: string, details: ValidatedTreeDetails): Promise<void> {
  for (const entry of details.entries.filter((candidate) => candidate.kind === "directory")) {
    const destination = nativePath(staging, entry.path);
    await ordinaryDirectory(path.dirname(destination));
    await fs.mkdir(destination, { mode: 0o700 });
    await ordinaryDirectory(destination);
  }
  for (const entry of details.entries.filter((candidate) => candidate.kind === "file")) {
    const destination = nativePath(staging, entry.path);
    await ordinaryDirectory(path.dirname(destination));
    const handle = await fs.open(destination, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, entry.executable === true ? 0o700 : 0o600);
    try {
      await handle.writeFile(entry.data ?? new Uint8Array());
      await handle.sync();
    } finally {
      await handle.close();
    }
    const stat = await fs.lstat(destination, { bigint: true });
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n) throw new Error("materialized file identity is unsafe");
  }
}

async function postvalidate(staging: string, details: ValidatedTreeDetails): Promise<{ readonly treeDigest: Sha256; readonly rootDigest: Sha256 }> {
  const expected = new Map(details.entries.map((entry) => [entry.path, entry]));
  const seen = new Set<string>();
  const observed: ArtifactDigestEntry[] = [];

  async function walk(directory: string, relative: string): Promise<void> {
    for (const name of await fs.readdir(directory)) {
      const childRelative = relative.length === 0 ? name : `${relative}/${name}`;
      const expectedEntry = expected.get(childRelative);
      if (expectedEntry === undefined) throw new Error("materialized tree contains an unexpected entry");
      const child = path.join(directory, name);
      const stat = await fs.lstat(child, { bigint: true });
      if (stat.isSymbolicLink()) throw new Error("materialized tree contains an alias");
      if (expectedEntry.kind === "directory") {
        if (!stat.isDirectory()) throw new Error("materialized directory identity changed");
        if (process.platform !== "win32" && (stat.mode & 0o077n) !== 0n) throw new Error("materialized directory permissions changed");
        seen.add(childRelative);
        observed.push({ path: childRelative, kind: "directory" });
        await walk(child, childRelative);
      } else {
        if (!stat.isFile() || stat.nlink !== 1n) throw new Error("materialized file identity changed");
        const data = await fs.readFile(child);
        const expectedData = expectedEntry.data ?? new Uint8Array();
        if (data.byteLength !== expectedData.byteLength || !data.equals(expectedData)) throw new Error("materialized file content changed");
        if (process.platform !== "win32" && ((stat.mode & 0o111n) !== 0n) !== (expectedEntry.executable === true)) {
          throw new Error("materialized file mode changed");
        }
        seen.add(childRelative);
        observed.push({ path: childRelative, kind: "file", executable: expectedEntry.executable === true, data });
      }
    }
  }

  await walk(staging, "");
  if (seen.size !== expected.size) throw new Error("materialized tree is incomplete");
  const treeDigest = digestArtifactEntries(observed);
  const rootDigest = digestArtifactEntries(observed, details.rootSelection.path);
  if (treeDigest !== details.treeDigest || rootDigest !== details.rootDigest) throw new Error("materialized tree digest changed");
  return { treeDigest, rootDigest };
}

export interface MaterializedPluginTreeDiscard {
  readonly removed: boolean;
  readonly inactive: true;
  readonly uncertain: boolean;
}

export async function discardMaterializedPluginTree(
  tree: MaterializedPluginTree,
): Promise<MaterializedPluginTreeDiscard> {
  const authority = materializedAuthorities.get(tree);
  if (authority === undefined) return Object.freeze({ removed: false, inactive: true, uncertain: true });
  materializedAuthorities.delete(tree);
  try {
    const current = await ordinaryDirectory(authority.staging);
    if (!sameIdentity(authority.identity, current)) {
      return Object.freeze({ removed: false, inactive: true, uncertain: true });
    }
    await fs.rm(authority.staging, { recursive: true, force: true });
    return Object.freeze({ removed: true, inactive: true, uncertain: false });
  } catch {
    return Object.freeze({ removed: false, inactive: true, uncertain: true });
  }
}

export async function materializePluginTree(
  plan: ValidatedPluginTree,
  privateStagingParent: PrivateStagingParent,
): Promise<ContractResult<MaterializedPluginTree>> {
  const details = plans.get(plan);
  const authority = stagingAuthorities.get(privateStagingParent);
  if (details === undefined || authority === undefined) {
    return lifecycleError("unsafe-descriptor", "Plugin tree or private staging capability was not issued by trusted validation");
  }

  let staging = "";
  let stagingIdentity: Identity | undefined;
  try {
    await revalidateAuthority(authority);
    staging = await fs.mkdtemp(path.join(authority.canonicalPath, ".picc-staging-"));
    await fs.chmod(staging, 0o700);
    stagingIdentity = identity(await ordinaryDirectory(staging));
    await createTree(staging, details);
    const observedDigests = await postvalidate(staging, details);
    await revalidateAuthority(authority);
    const finalStaging = await ordinaryDirectory(staging);
    if (!sameIdentity(stagingIdentity, finalStaging)) throw new Error("staging authority identity changed");
    const root = details.rootSelection.path.length === 0 ? staging : nativePath(staging, details.rootSelection.path);
    await ordinaryDirectory(root);
    const materialized = Object.freeze({
      stagingDirectory: staging,
      pluginRoot: root,
      treeDigest: observedDigests.treeDigest,
      rootDigest: observedDigests.rootDigest,
      rootSelection: details.rootSelection,
      entryCount: details.entries.length,
      fileCount: details.fileCount,
      totalBytes: details.totalBytes,
    }) as MaterializedPluginTree;
    materializedAuthorities.set(materialized, { staging, identity: stagingIdentity });
    return { ok: true, value: materialized };
  } catch {
    await removeIfStillOwned(staging, stagingIdentity);
    return lifecycleError("unsafe-descriptor", "Plugin tree could not be safely materialized in the private staging parent");
  }
}

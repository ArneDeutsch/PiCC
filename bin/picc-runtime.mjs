import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const MANIFEST_NAME = "picc-runtime.json";
const CONFIG_PATH = "tsconfig.runtime.json";
const LOCK_PATH = "package-lock.json";
const EXTENSION_ENTRY = "picc/index.ts";
const INVENTORY_ENTRY = "dist/plugin-inventory-cli.js";
const MCP_ADMINISTRATION_ENTRY = "dist/mcp-administration-cli.js";
const SOURCE_EXTENSION_ENTRY = "picc/index.ts";
const SOURCE_INVENTORY_ENTRY = "src/plugin-inventory-cli.ts";
const SOURCE_MCP_ADMINISTRATION_ENTRY = "src/mcp-administration-cli.ts";
const REQUIRED_RUNTIME_FILES = [
  "dist/index.js",
  "dist/index.js.map",
  INVENTORY_ENTRY,
  `${INVENTORY_ENTRY}.map`,
  MCP_ADMINISTRATION_ENTRY,
  `${MCP_ADMINISTRATION_ENTRY}.map`,
];
const HEX = /^[0-9a-f]{64}$/u;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/u;
const GRAPH_KEYS = ["agentCore", "ai", "aiCompat", "codingAgent", "tui", "typebox", "typeboxCompile"];
const GRAPH_WITNESSES = Object.freeze({
  agentCore: ["Agent", "calculateContextTokens"],
  ai: ["StringEnum", "Type"],
  aiCompat: ["StringEnum", "openAICodexResponsesApi"],
  codingAgent: ["SessionManager", "createAgentSession", "defineTool", "withFileMutationQueue"],
  tui: ["Box", "KeybindingsManager", "getKeybindings", "visibleWidth"],
  typebox: ["Type", "Object"],
  typeboxCompile: ["Compile", "Validator"],
});

let retainedGraph;
let fallbackGraph;
const retainedRepresentations = new Map();
const presentedSourceNotices = new Set();
const canonicalRuntimeUrl = new URL(import.meta.url);
canonicalRuntimeUrl.search = "";
canonicalRuntimeUrl.hash = "";
const canonicalRuntime = canonicalRuntimeUrl.href === import.meta.url ? undefined : await import(canonicalRuntimeUrl.href);
const verifierProvenance = new WeakMap();
const selectionProvenance = new WeakMap();
let pendingInitialSelection;
let initialSelectionClosed = false;

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function compactDigest(value) {
  return sha256(Buffer.from(JSON.stringify(value), "utf8"));
}

function deepFreeze(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function exactKeys(value, keys) {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.keys(value).length === keys.length
    && keys.every((key) => Object.hasOwn(value, key));
}

function validRelativePath(value) {
  if (typeof value !== "string" || value.length === 0 || value !== value.normalize("NFC")) return false;
  if (CONTROL.test(value) || value.includes("\\") || value.startsWith("/") || /^[A-Za-z]:/u.test(value)) return false;
  return value.split("/").every((part) => part.length > 0 && part !== "." && part !== "..");
}

function bytewiseCompare(left, right) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function physicalPathKey(value) {
  return process.platform === "win32" ? value.toLowerCase() : value;
}

function samePhysicalPath(left, right) {
  return physicalPathKey(left) === physicalPathKey(right);
}

function validRecords(value) {
  if (!Array.isArray(value)) return false;
  const folded = new Set();
  let previous;
  for (const record of value) {
    if (!exactKeys(record, ["path", "sha256"]) || !validRelativePath(record.path) || !HEX.test(record.sha256)) return false;
    if (previous !== undefined && bytewiseCompare(previous, record.path) >= 0) return false;
    previous = record.path;
    const fold = record.path.toUpperCase().toLowerCase();
    if (folded.has(fold)) return false;
    folded.add(fold);
  }
  return true;
}

function validPackage(value) {
  return exactKeys(value, ["name", "version", "type"])
    && typeof value.name === "string" && value.name.length > 0
    && typeof value.version === "string" && value.version.length > 0
    && typeof value.type === "string" && value.type.length > 0;
}

function validCompiler(value) {
  return exactKeys(value, ["typescriptVersion", "configPath", "configSha256", "dependencyLockPath", "dependencyLockSha256"])
    && typeof value.typescriptVersion === "string" && value.typescriptVersion.length > 0
    && value.configPath === CONFIG_PATH && HEX.test(value.configSha256)
    && value.dependencyLockPath === LOCK_PATH && HEX.test(value.dependencyLockSha256);
}

function validateManifest(value) {
  if (!exactKeys(value, ["schemaVersion", "package", "compiler", "sources", "sourceDigest", "files", "runtimeDigest", "entries"])) return false;
  if (value.schemaVersion !== 1 || !validPackage(value.package) || !validCompiler(value.compiler)) return false;
  if (!validRecords(value.sources) || !validRecords(value.files) || !HEX.test(value.sourceDigest) || !HEX.test(value.runtimeDigest)) return false;
  if (!exactKeys(value.entries, ["extension", "pluginInventory", "mcpAdministration"])) return false;
  if (value.entries.extension !== EXTENSION_ENTRY || value.entries.pluginInventory !== INVENTORY_ENTRY || value.entries.mcpAdministration !== MCP_ADMINISTRATION_ENTRY) return false;
  if (!value.sources.every((record) => record.path.startsWith("src/") && record.path.endsWith(".ts"))) return false;
  const filePaths = new Set(value.files.map((record) => record.path));
  if (!filePaths.has(EXTENSION_ENTRY) || !REQUIRED_RUNTIME_FILES.every((required) => filePaths.has(required))) return false;
  return value.files.every((record) => record.path === EXTENSION_ENTRY
    || (record.path.startsWith("dist/") && (record.path.endsWith(".js") || record.path.endsWith(".js.map"))));
}

function isContained(root, target) {
  const relative = path.relative(root, target);
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

function assertNoLinksPath(root, target, kind) {
  if (!isContained(root, target)) throw new Error("path escapes package root");
  let cursor = root;
  const rootStat = fs.lstatSync(root);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new Error("invalid package root");
  for (const part of path.relative(root, target).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    const stat = fs.lstatSync(cursor);
    if (stat.isSymbolicLink()) throw new Error("symbolic link");
  }
  const stat = fs.lstatSync(target);
  if ((kind === "file" && !stat.isFile()) || (kind === "directory" && !stat.isDirectory())) throw new Error("non-regular path");
}

function stableStat(target, kind) {
  const stat = fs.lstatSync(target, { bigint: true });
  if (stat.isSymbolicLink() || (kind === "file" ? !stat.isFile() : !stat.isDirectory())) throw new Error("unsupported path identity");
  const fields = ["dev", "ino", "mode", "nlink", "size", "mtimeNs", "ctimeNs", "birthtimeNs"];
  const identity = {};
  for (const field of fields) {
    if (typeof stat[field] !== "bigint") throw new Error("unsupported path identity");
    identity[field] = stat[field];
  }
  return Object.freeze(identity);
}

function sameStableStat(left, right) {
  return Object.keys(left).every((field) => left[field] === right[field]);
}

function regularNoLinks(root, target) {
  try {
    assertNoLinksPath(root, target, "file");
    return true;
  } catch {
    return false;
  }
}

function readStableFile(root, target, evidence) {
  assertNoLinksPath(root, target, "file");
  const before = stableStat(target, "file");
  const bytes = fs.readFileSync(target);
  const after = stableStat(target, "file");
  if (!sameStableStat(before, after)) throw new Error("file changed during verification");
  evidence?.files.set(target, Object.freeze({ root, path: target, identity: after }));
  return bytes;
}

function walkRegularFiles(root, evidence) {
  const output = [];
  function visit(directory, relativeDirectory) {
    const before = stableStat(directory, "directory");
    const entries = fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => bytewiseCompare(a.name, b.name));
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      const relative = relativeDirectory === "" ? entry.name : `${relativeDirectory}/${entry.name}`;
      const stat = fs.lstatSync(absolute);
      if (stat.isSymbolicLink()) throw new Error("symbolic link");
      if (stat.isDirectory()) visit(absolute, relative);
      else if (stat.isFile()) output.push(relative.normalize("NFC"));
      else throw new Error("non-regular output");
    }
    const after = stableStat(directory, "directory");
    if (!sameStableStat(before, after)) throw new Error("directory changed during verification");
    evidence?.inventories.set(directory, Object.freeze({ path: directory, identity: after }));
  }
  visit(root, "");
  if (evidence) evidence.inventorySets.set(root, Object.freeze([...output]));
  return output;
}

function captureExactBootstrapInventory(root, evidence) {
  const bootstrapDirectory = path.join(root, "picc");
  assertNoLinksPath(root, bootstrapDirectory, "directory");
  const bootstrapFiles = walkRegularFiles(bootstrapDirectory, evidence);
  if (JSON.stringify(bootstrapFiles) !== JSON.stringify(["index.ts"])) {
    throw new Error("invalid bootstrap inventory");
  }
  return bootstrapFiles;
}

function physicalRuntimePath(packageRoot, distDirectory, manifestPath) {
  if (manifestPath.startsWith("dist/")) return path.join(distDirectory, ...manifestPath.slice(5).split("/"));
  return path.join(packageRoot, ...manifestPath.split("/"));
}

function mapIsSafe(packageRoot, manifestPath, bytes, sourcePaths) {
  let map;
  try {
    map = JSON.parse(bytes.toString("utf8"));
  } catch {
    return false;
  }
  if (map === null || typeof map !== "object" || Array.isArray(map) || map.version !== 3 || !Array.isArray(map.sources)) return false;
  if (typeof map.file !== "string" || map.file !== path.posix.basename(manifestPath, ".map")) return false;
  if (Object.hasOwn(map, "sourceRoot") && map.sourceRoot !== "") return false;
  const conceptualDirectory = path.dirname(path.join(packageRoot, ...manifestPath.split("/")));
  for (const source of map.sources) {
    if (typeof source !== "string" || source.length === 0 || source !== source.normalize("NFC")) return false;
    if (CONTROL.test(source) || source.includes("\\") || source.startsWith("/") || /^[A-Za-z]:/u.test(source) || /^[a-z][a-z0-9+.-]*:/iu.test(source)) return false;
    const resolved = path.resolve(conceptualDirectory, ...source.split("/"));
    if (!isContained(packageRoot, resolved)) return false;
    const relative = path.relative(packageRoot, resolved).split(path.sep).join("/");
    if (!sourcePaths.has(relative)) return false;
  }
  return true;
}

function readContainedFile(packageRoot, relativePath, evidence) {
  const target = path.join(packageRoot, ...relativePath.split("/"));
  return readStableFile(packageRoot, target, evidence);
}

function readPackageIdentity(packageRoot, evidence) {
  const parsed = JSON.parse(readContainedFile(packageRoot, "package.json", evidence).toString("utf8"));
  const value = { name: parsed.name, version: parsed.version, type: parsed.type };
  if (!validPackage(value)) throw new Error("invalid package identity");
  return value;
}

function readTypeScriptVersion(packageRoot, evidence) {
  const require = createRequire(path.join(packageRoot, "package.json"));
  const packageJsonPath = require.resolve("typescript/package.json");
  const parsed = JSON.parse(readStableFile(path.dirname(packageJsonPath), packageJsonPath, evidence).toString("utf8"));
  if (typeof parsed.version !== "string" || parsed.version.length === 0) throw new Error("invalid TypeScript identity");
  return parsed.version;
}

function readSourceRecords(packageRoot, evidence) {
  const sourceRoot = path.join(packageRoot, "src");
  assertNoLinksPath(packageRoot, sourceRoot, "directory");
  const paths = walkRegularFiles(sourceRoot, evidence)
    .filter((relative) => relative.endsWith(".ts"))
    .map((relative) => `src/${relative}`)
    .sort(bytewiseCompare);
  return paths.map((sourcePath) => ({ path: sourcePath, sha256: sha256(readContainedFile(packageRoot, sourcePath, evidence)) }));
}

function validateRuntimeConfig(raw) {
  const parsed = JSON.parse(raw.toString("utf8"));
  if (!exactKeys(parsed, ["compilerOptions", "include", "exclude"])) throw new Error("runtime config shape is not exact");
  if (JSON.stringify(parsed.include) !== JSON.stringify(["src/**/*.ts"])) throw new Error("runtime config source set is not exact");
  if (JSON.stringify(parsed.exclude) !== JSON.stringify(["node_modules", "dist", "test", "examples"])) throw new Error("runtime config exclusions are not exact");
  const options = parsed.compilerOptions;
  const optionKeys = [
    "target", "module", "moduleResolution", "lib", "strict", "noUncheckedIndexedAccess", "esModuleInterop",
    "skipLibCheck", "forceConsistentCasingInFileNames", "resolveJsonModule", "allowJs", "checkJs", "sourceMap",
    "inlineSourceMap", "inlineSources", "declaration", "declarationMap", "noEmit", "emitDeclarationOnly", "rootDir", "types",
  ];
  if (!exactKeys(options, optionKeys)) throw new Error("runtime compiler options are not exact");
  const expected = {
    target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", lib: ["ES2022"], strict: true,
    noUncheckedIndexedAccess: true, esModuleInterop: true, skipLibCheck: true, forceConsistentCasingInFileNames: true,
    resolveJsonModule: false, allowJs: false, checkJs: false, sourceMap: true, inlineSourceMap: false, inlineSources: false,
    declaration: false, declarationMap: false, noEmit: false, emitDeclarationOnly: false, rootDir: "src",
  };
  for (const [key, expectedValue] of Object.entries(expected)) {
    if (JSON.stringify(options[key]) !== JSON.stringify(expectedValue)) throw new Error("runtime compiler options do not preserve the emit contract");
  }
  if (!Array.isArray(options.types) || !options.types.every((value) => typeof value === "string")) throw new Error("runtime compiler types are invalid");
}

function collectCompilationIdentityWithEvidence(packageRoot, evidence) {
  if (typeof packageRoot !== "string" || packageRoot.length === 0) throw new TypeError("packageRoot must be a non-empty string");
  const root = path.resolve(packageRoot);
  const configBytes = readContainedFile(root, CONFIG_PATH, evidence);
  validateRuntimeConfig(configBytes);
  const lockBytes = readContainedFile(root, LOCK_PATH, evidence);
  const packageIdentity = readPackageIdentity(root, evidence);
  const compiler = {
    typescriptVersion: readTypeScriptVersion(root, evidence),
    configPath: CONFIG_PATH,
    configSha256: sha256(configBytes),
    dependencyLockPath: LOCK_PATH,
    dependencyLockSha256: sha256(lockBytes),
  };
  const sources = readSourceRecords(root, evidence);
  return { package: packageIdentity, compiler, sources, sourceDigest: compactDigest({ package: packageIdentity, compiler, sources }) };
}

export function collectCompilationIdentity(packageRoot) {
  return collectCompilationIdentityWithEvidence(packageRoot);
}

function failure(category, reason) {
  return { ok: false, category, reason };
}

function createVerificationEvidence() {
  return { files: new Map(), inventories: new Map(), inventorySets: new Map(), manifestDigest: undefined };
}

function freezeVerificationEvidence(evidence) {
  return Object.freeze({
    files: Object.freeze([...evidence.files.values()]),
    inventories: Object.freeze([...evidence.inventories.values()]),
    inventorySets: Object.freeze([...evidence.inventorySets].map(([root, files]) => Object.freeze({ root, files }))),
    manifestDigest: evidence.manifestDigest,
  });
}

function captureSourceRepresentationEvidence(root) {
  const evidence = createVerificationEvidence();
  evidence.inventories.set(root, Object.freeze({ path: root, identity: stableStat(root, "directory") }));
  const sourceDirectory = path.join(root, "src");
  const bootstrapDirectory = path.join(root, "picc");
  for (const [directory, relativePaths] of [
    [sourceDirectory, walkRegularFiles(sourceDirectory, evidence)],
    [bootstrapDirectory, captureExactBootstrapInventory(root, evidence)],
  ]) {
    for (const relativePath of relativePaths) {
      const target = path.join(directory, ...relativePath.split("/"));
      evidence.files.set(target, Object.freeze({ root: directory, path: target, identity: stableStat(target, "file") }));
    }
  }
  for (const relativePath of ["package.json", CONFIG_PATH, LOCK_PATH]) {
    const target = path.join(root, relativePath);
    evidence.files.set(target, Object.freeze({ root, path: target, identity: stableStat(target, "file") }));
  }
  const captured = freezeVerificationEvidence(evidence);
  if (!evidenceStillMatches(captured)) throw new Error("source representation changed during capture");
  return captured;
}

function evidenceStillMatches(evidence) {
  try {
    for (const observation of evidence.files) {
      assertNoLinksPath(observation.root, observation.path, "file");
      if (!sameStableStat(observation.identity, stableStat(observation.path, "file"))) return false;
    }
    for (const observation of evidence.inventories) {
      if (!sameStableStat(observation.identity, stableStat(observation.path, "directory"))) return false;
    }
    for (const inventory of evidence.inventorySets) {
      if (JSON.stringify(walkRegularFiles(inventory.root)) !== JSON.stringify(inventory.files)) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function isMissingError(error) {
  return error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT";
}

/** @typedef {{path: string, sha256: string}} RuntimeFileRecord */
/** @typedef {{name: string, version: string, type: string}} RuntimePackageIdentity */
/** @typedef {{typescriptVersion: string, configPath: "tsconfig.runtime.json", configSha256: string, dependencyLockPath: "package-lock.json", dependencyLockSha256: string}} RuntimeCompilerIdentity */
/**
 * @typedef {object} RuntimeManifestV1
 * @property {1} schemaVersion
 * @property {RuntimePackageIdentity} package
 * @property {RuntimeCompilerIdentity} compiler
 * @property {RuntimeFileRecord[]} sources
 * @property {string} sourceDigest
 * @property {RuntimeFileRecord[]} files
 * @property {string} runtimeDigest
 * @property {{extension: "picc/index.ts", pluginInventory: "dist/plugin-inventory-cli.js", mcpAdministration: "dist/mcp-administration-cli.js"}} entries
 */
/** @typedef {{extensionPath: string, pluginInventoryPath: string, mcpAdministrationPath: string}} RuntimeEntries */
/** @typedef {{ok: true, manifest: RuntimeManifestV1, entries: RuntimeEntries} | {ok: false, category: "missing" | "source-stale" | "corrupt" | "version-mismatch", reason: string}} VerifyResult */

/** @param {{packageRoot: string, checkSource?: boolean, distDirectory?: string}} options @returns {VerifyResult} */
export function verifyCompiledRuntime({ packageRoot, checkSource = false, distDirectory }) {
  if (typeof packageRoot !== "string" || packageRoot.length === 0) throw new TypeError("packageRoot must be a non-empty string");
  if (typeof checkSource !== "boolean") throw new TypeError("checkSource must be a boolean");
  if (distDirectory !== undefined && (typeof distDirectory !== "string" || distDirectory.length === 0)) throw new TypeError("distDirectory must be a non-empty string");

  const root = path.resolve(packageRoot);
  const dist = path.resolve(distDirectory ?? path.join(root, "dist"));
  const evidence = createVerificationEvidence();
  try {
    evidence.inventories.set(root, Object.freeze({ path: root, identity: stableStat(root, "directory") }));
  } catch {
    return failure("corrupt", "The PiCC package root cannot be accessed safely.");
  }
  let distStat;
  try {
    distStat = fs.lstatSync(dist);
  } catch (error) {
    return isMissingError(error)
      ? failure("missing", "The compiled PiCC runtime is missing.")
      : failure("corrupt", "The compiled PiCC runtime cannot be accessed safely.");
  }
  if (distStat.isSymbolicLink() || !distStat.isDirectory()) return failure("corrupt", "The compiled PiCC runtime directory is invalid.");

  try {
    captureExactBootstrapInventory(root, evidence);
  } catch {
    return failure("corrupt", "The PiCC extension bootstrap has missing, legacy, case-colliding, or unexpected files.");
  }

  const manifestPath = path.join(dist, MANIFEST_NAME);
  let manifestStat;
  try {
    manifestStat = fs.lstatSync(manifestPath);
  } catch (error) {
    return isMissingError(error)
      ? failure("missing", "The compiled PiCC runtime identity is missing.")
      : failure("corrupt", "The compiled PiCC runtime identity cannot be accessed safely.");
  }
  if (manifestStat.isSymbolicLink() || !manifestStat.isFile()) return failure("corrupt", "The compiled PiCC runtime identity is invalid.");

  let manifest;
  try {
    const manifestBytes = readStableFile(dist, manifestPath, evidence);
    evidence.manifestDigest = sha256(manifestBytes);
    manifest = JSON.parse(manifestBytes.toString("utf8"));
  } catch {
    return failure("corrupt", "The compiled PiCC runtime identity changed or is malformed.");
  }
  if (!validateManifest(manifest)) return failure("corrupt", "The compiled PiCC runtime identity has an unsupported or malformed shape.");
  if (compactDigest({ package: manifest.package, compiler: manifest.compiler, sources: manifest.sources }) !== manifest.sourceDigest
    || compactDigest(manifest.files) !== manifest.runtimeDigest) {
    return failure("corrupt", "The compiled PiCC runtime identity is internally inconsistent.");
  }

  let actualDistFiles;
  try {
    actualDistFiles = walkRegularFiles(dist, evidence).filter((relative) => relative !== MANIFEST_NAME).sort(bytewiseCompare);
  } catch {
    return failure("corrupt", "The compiled PiCC runtime contains an inaccessible or invalid path.");
  }
  const recordedDistFiles = manifest.files.filter((record) => record.path.startsWith("dist/")).map((record) => record.path.slice(5));
  if (JSON.stringify(actualDistFiles) !== JSON.stringify(recordedDistFiles)) return failure("corrupt", "The compiled PiCC runtime has missing or unexpected files.");

  const fileSet = new Set(manifest.files.map((record) => record.path));
  const sourcePaths = new Set(manifest.sources.map((record) => record.path));
  for (const record of manifest.files) {
    const physical = physicalRuntimePath(root, dist, record.path);
    const containmentRoot = record.path.startsWith("dist/") ? dist : root;
    if (!regularNoLinks(containmentRoot, physical)) return failure("corrupt", "A compiled PiCC runtime file is missing or invalid.");
    let bytes;
    try {
      bytes = readStableFile(containmentRoot, physical, evidence);
    } catch {
      return failure("corrupt", "A compiled PiCC runtime file changed or cannot be accessed safely.");
    }
    if (sha256(bytes) !== record.sha256) return failure("corrupt", "A compiled PiCC runtime file failed its integrity check.");
    if (record.path.endsWith(".js") && record.path.startsWith("dist/") && !fileSet.has(`${record.path}.map`)) return failure("corrupt", "A compiled PiCC runtime source map is missing.");
    if (record.path.endsWith(".js.map") && (!fileSet.has(record.path.slice(0, -4)) || !mapIsSafe(root, record.path, bytes, sourcePaths))) {
      return failure("corrupt", "A compiled PiCC runtime source map is invalid.");
    }
  }

  const runtimeEvidence = freezeVerificationEvidence(evidence);
  if (!evidenceStillMatches(runtimeEvidence)) return failure("corrupt", "The compiled PiCC runtime changed during verification.");

  if (checkSource) {
    let current;
    try {
      current = collectCompilationIdentityWithEvidence(root, evidence);
    } catch {
      return failure("source-stale", "The source checkout compilation inputs changed or are invalid.");
    }
    if (current.sourceDigest !== manifest.sourceDigest) return failure("source-stale", "The source checkout changed after the compiled runtime was built.");
    if (!evidenceStillMatches(runtimeEvidence)) return failure("corrupt", "The compiled PiCC runtime changed during verification.");
    if (!evidenceStillMatches(freezeVerificationEvidence(evidence))) return failure("source-stale", "The source checkout changed during verification.");
  } else {
    let currentPackage;
    try {
      currentPackage = readPackageIdentity(root, evidence);
    } catch {
      return failure("version-mismatch", "The installed PiCC package identity is invalid.");
    }
    if (JSON.stringify(currentPackage) !== JSON.stringify(manifest.package)) return failure("version-mismatch", "The installed PiCC runtime does not match the package identity.");
    if (!evidenceStillMatches(runtimeEvidence)) return failure("corrupt", "The compiled PiCC runtime changed during verification.");
    if (!evidenceStillMatches(freezeVerificationEvidence(evidence))) return failure("version-mismatch", "The installed PiCC package identity changed during verification.");
  }

  const entries = deepFreeze({ extensionPath: manifest.entries.extension, pluginInventoryPath: manifest.entries.pluginInventory, mcpAdministrationPath: manifest.entries.mcpAdministration });
  deepFreeze(manifest);
  const result = Object.freeze({ ok: true, manifest, entries });
  verifierProvenance.set(result, Object.freeze({ root: fs.realpathSync.native(root), checkSource, evidence: freezeVerificationEvidence(evidence) }));
  return result;
}

function validatedPhysicalRoot(packageRoot) {
  if (typeof packageRoot !== "string" || packageRoot.length === 0 || !path.isAbsolute(packageRoot)) throw new TypeError("packageRoot must be an absolute physical path");
  const resolved = path.resolve(packageRoot);
  const physical = fs.realpathSync.native(resolved);
  if (!samePhysicalPath(physical, packageRoot)) throw new TypeError("packageRoot must retain its native physical spelling");
  return physical;
}

function validateInstallKind(installationKind) {
  if (installationKind !== "installed" && installationKind !== "source") throw new TypeError("installationKind must be 'installed' or 'source'");
}

function graphIsValid(graph) {
  if (!exactKeys(graph, GRAPH_KEYS)) return false;
  for (const [packageName, names] of Object.entries(GRAPH_WITNESSES)) {
    const namespace = graph[packageName];
    if (namespace === null || (typeof namespace !== "object" && typeof namespace !== "function")) return false;
    for (const name of names) if (!(name in namespace)) return false;
  }
  return true;
}

function sameGraph(left, right) {
  for (const [packageName, names] of Object.entries(GRAPH_WITNESSES)) {
    for (const name of names) if (left[packageName][name] !== right[packageName][name]) return false;
  }
  return true;
}

function snapshotNamespace(namespace) {
  const retained = {};
  for (const key of Reflect.ownKeys(namespace)) {
    const descriptor = Reflect.getOwnPropertyDescriptor(namespace, key);
    Reflect.defineProperty(retained, key, {
      value: namespace[key],
      enumerable: descriptor?.enumerable ?? false,
      configurable: true,
      writable: true,
    });
  }
  return Object.freeze(retained);
}

export function installRuntimeHostGraph(graph) {
  if (!graphIsValid(graph)) throw new TypeError("PiCC runtime host graph is malformed.");
  if (retainedGraph !== undefined) {
    if (!sameGraph(retainedGraph, graph)) throw new Error("PiCC refused to mix non-identical Pi runtime package graphs in one process.");
    return retainedGraph;
  }
  retainedGraph = Object.freeze(Object.fromEntries(GRAPH_KEYS.map((key) => [key, snapshotNamespace(graph[key])])));
  return retainedGraph;
}

export function getRuntimeHostGraph() {
  return retainedGraph;
}

export function acquireFallbackRuntimeHostGraph() {
  if (retainedGraph !== undefined) return Promise.resolve(retainedGraph);
  fallbackGraph ??= Promise.all([
    import("@earendil-works/pi-agent-core"), import("@earendil-works/pi-ai"), import("@earendil-works/pi-ai/compat"),
    import("@earendil-works/pi-coding-agent"), import("@earendil-works/pi-tui"), import("typebox"), import("typebox/compile"),
  ]).then(([agentCore, ai, aiCompat, codingAgent, tui, typebox, typeboxCompile]) =>
    installRuntimeHostGraph({ agentCore, ai, aiCompat, codingAgent, tui, typebox, typeboxCompile }));
  return fallbackGraph;
}

export function pinPiccRuntime({ packageRoot, installationKind, selection }) {
  if (canonicalRuntime !== undefined) return canonicalRuntime.pinPiccRuntime({ packageRoot, installationKind, selection });
  const root = validatedPhysicalRoot(packageRoot);
  validateInstallKind(installationKind);
  if (selection === null || typeof selection !== "object" || selection.ok !== true || (selection.mode !== "compiled" && selection.mode !== "source")) {
    throw new TypeError("selection must be a successful PiCC runtime selection");
  }
  if (installationKind === "installed" && selection.mode !== "compiled") throw new TypeError("installed PiCC cannot pin source mode");
  let generation;
  if (selection.mode === "compiled") {
    const sourceDigest = selection.manifest?.sourceDigest;
    const runtimeDigest = selection.manifest?.runtimeDigest;
    if (!HEX.test(sourceDigest) || !HEX.test(runtimeDigest) || selection.notice !== null) throw new TypeError("compiled PiCC generation is malformed");
    generation = Object.freeze({ sourceDigest, runtimeDigest });
  } else if (selection.manifest !== undefined || (selection.notice?.category !== "missing" && selection.notice?.category !== "source-stale")
    || typeof selection.notice.message !== "string" || selection.notice.message.length === 0) {
    throw new TypeError("source PiCC selection is malformed");
  }
  const key = physicalPathKey(root);
  const retained = retainedRepresentations.get(key);
  if (retained?.mode === "source") {
    if (!samePhysicalPath(retained.root, root) || retained.installationKind !== installationKind) {
      throw new Error("The PiCC runtime changed while this process was running. `/reload` cannot apply this runtime change; exit PiCC and relaunch.");
    }
    return retained;
  }
  const candidate = Object.freeze({ root, installationKind, mode: selection.mode, generation });
  if (retained !== undefined) {
    if (!samePhysicalPath(retained.root, candidate.root) || retained.installationKind !== candidate.installationKind || retained.mode !== candidate.mode
      || retained.generation?.sourceDigest !== candidate.generation?.sourceDigest || retained.generation?.runtimeDigest !== candidate.generation?.runtimeDigest) {
      throw new Error("The verified PiCC runtime changed while this process was running. `/reload` cannot apply this runtime change; exit PiCC and relaunch.");
    }
    return retained;
  }
  retainedRepresentations.set(key, candidate);
  return candidate;
}

export function presentPiccSourceNotice({ packageRoot, installationKind, representation, selection }) {
  if (canonicalRuntime !== undefined) return canonicalRuntime.presentPiccSourceNotice({ packageRoot, installationKind, representation, selection });
  const root = validatedPhysicalRoot(packageRoot);
  validateInstallKind(installationKind);
  if (installationKind !== "source" || representation?.root !== root || representation.mode !== "source" || selection?.ok !== true || selection.mode !== "source"
    || selection.notice === null || typeof selection.notice?.message !== "string") throw new TypeError("source notice state is malformed");
  const key = physicalPathKey(root);
  if (presentedSourceNotices.has(key)) return false;
  presentedSourceNotices.add(key);
  console.error(selection.notice.message);
  return true;
}

/**
 * @typedef {{ok: true, mode: "compiled", entries: RuntimeEntries, manifest: RuntimeManifestV1, notice: null}
 * | {ok: true, mode: "source", entries: RuntimeEntries, notice: {category: "missing" | "source-stale", message: string}}
 * | {ok: false, category: "missing" | "corrupt" | "version-mismatch", reason: string}} SelectionResult
 */
/** @param {{packageRoot: string, installationKind: "installed" | "source"}} options @returns {SelectionResult} */
export function selectPiccRuntime({ packageRoot, installationKind }) {
  if (canonicalRuntime !== undefined) return canonicalRuntime.selectPiccRuntime({ packageRoot, installationKind });
  validateInstallKind(installationKind);
  const resolvedRoot = path.resolve(packageRoot);
  const pending = pendingInitialSelection;
  if (pending !== undefined) {
    pendingInitialSelection = undefined;
    initialSelectionClosed = true;
    let physicalRoot;
    try {
      physicalRoot = fs.realpathSync.native(resolvedRoot);
    } catch {
      physicalRoot = undefined;
    }
    if (physicalRoot === undefined) return selectionFailure(installationKind, "corrupt");
    if (!samePhysicalPath(physicalRoot, pending.root) || installationKind !== pending.installationKind) return startupContextMismatchFailure();
    const retained = retainedRepresentations.get(physicalPathKey(physicalRoot));
    const retainedMismatch = retained !== undefined && (!samePhysicalPath(retained.root, physicalRoot) || retained.installationKind !== installationKind
      || retained.mode !== pending.mode || (pending.mode === "compiled" && (retained.generation?.sourceDigest !== pending.selection.manifest.sourceDigest
        || retained.generation?.runtimeDigest !== pending.selection.manifest.runtimeDigest)));
    if (retainedMismatch) return replacementSelectionFailure(installationKind);
    if (pending.mode === "source") {
      if (!evidenceStillMatches(pending.evidence)) return sourceCaptureFailure();
    } else if (!evidenceStillMatches(pending.evidence)) {
      return selectionFailure(installationKind, "corrupt");
    }
    return pending.selection;
  }

  const verified = verifyCompiledRuntime({ packageRoot: resolvedRoot, checkSource: installationKind === "source" });
  if (verified.ok) {
    const verifier = verifierProvenance.get(verified);
    if (verifier === undefined || verifier.checkSource !== (installationKind === "source")) return selectionFailure(installationKind, "corrupt");
    const selection = Object.freeze({ ok: true, mode: "compiled", entries: verified.entries, manifest: verified.manifest, notice: null });
    selectionProvenance.set(selection, Object.freeze({ root: verifier.root, installationKind, mode: "compiled", evidence: verifier.evidence }));
    return selection;
  }
  if (installationKind === "source" && (verified.category === "missing" || verified.category === "source-stale")) {
    const message = verified.category === "missing"
      ? "PiCC is using TypeScript source because the compiled runtime is missing. Run `npm run build` from the PiCC checkout root, then exit and relaunch PiCC to restore compiled startup."
      : "PiCC is using TypeScript source because the compiled runtime does not match this checkout. Run `npm run build` from the PiCC checkout root; `/reload` cannot apply this runtime change, so exit PiCC and relaunch.";
    try {
      const physicalRoot = fs.realpathSync.native(resolvedRoot);
      const evidence = captureSourceRepresentationEvidence(physicalRoot);
      const selection = deepFreeze({ ok: true, mode: "source", entries: { extensionPath: SOURCE_EXTENSION_ENTRY, pluginInventoryPath: SOURCE_INVENTORY_ENTRY, mcpAdministrationPath: SOURCE_MCP_ADMINISTRATION_ENTRY }, notice: { category: verified.category, message } });
      selectionProvenance.set(selection, Object.freeze({ root: physicalRoot, evidence, installationKind, mode: "source" }));
      return selection;
    } catch {
      return sourceCaptureFailure();
    }
  }
  return selectionFailure(installationKind, verified.category);
}

function selectionFailure(installationKind, category) {
  const reason = installationKind === "installed"
    ? `The installed PiCC runtime is ${category === "missing" ? "missing" : category === "version-mismatch" ? "version-incoherent" : "damaged"}. Update or reinstall PiCC, then relaunch.`
    : "The source-checkout compiled runtime is damaged. Run `npm run build` from the PiCC checkout root, then exit and relaunch PiCC.";
  return { ok: false, category, reason };
}

function startupContextMismatchFailure() {
  return { ok: false, category: "corrupt", reason: "PiCC startup context does not match this launch. Exit PiCC and relaunch from the intended installation." };
}

function replacementSelectionFailure(installationKind) {
  const reason = installationKind === "installed"
    ? "The PiCC runtime changed while this process was running. Update or reinstall PiCC; `/reload` cannot apply this runtime change, so exit PiCC and relaunch."
    : "The PiCC runtime changed while this process was running. Run `npm run build` from the PiCC checkout root; `/reload` cannot apply this runtime change, so exit PiCC and relaunch.";
  return { ok: false, category: "corrupt", reason };
}

function sourceCaptureFailure() {
  return { ok: false, category: "corrupt", reason: "The source checkout changed while PiCC was starting. Run `npm run build` from the PiCC checkout root, then exit and relaunch PiCC." };
}

function startupHandoffError(installationKind) {
  const message = installationKind === "source"
    ? "PiCC startup could not be prepared safely. Run `npm run build` from the PiCC checkout root, then exit PiCC and relaunch."
    : "PiCC startup could not be prepared safely. Exit PiCC, repair or reinstall it, then relaunch.";
  return new TypeError(message);
}

/** @param {SelectionResult} selection */
export function installInitialRuntimeSelection(selection) {
  if (canonicalRuntime !== undefined) return canonicalRuntime.installInitialRuntimeSelection(selection);
  const provenance = selectionProvenance.get(selection);
  if (provenance === undefined || selection?.ok !== true || selection.mode !== provenance.mode) throw startupHandoffError();
  if (provenance.installationKind === "installed" && selection.mode !== "compiled") throw startupHandoffError(provenance.installationKind);
  if (initialSelectionClosed || pendingInitialSelection !== undefined) throw startupHandoffError(provenance.installationKind);
  pendingInitialSelection = Object.freeze({
    root: provenance.root,
    installationKind: provenance.installationKind,
    mode: provenance.mode,
    selection,
    evidence: provenance.evidence,
  });
}

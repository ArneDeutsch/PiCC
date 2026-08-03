import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const MANIFEST_NAME = "picc-runtime.json";
const CONFIG_PATH = "tsconfig.runtime.json";
const LOCK_PATH = "package-lock.json";
const EXTENSION_ENTRY = "picc/index.js";
const INVENTORY_ENTRY = "dist/plugin-inventory-cli.js";
const SOURCE_EXTENSION_ENTRY = "picc/index.ts";
const SOURCE_INVENTORY_ENTRY = "src/plugin-inventory-cli.ts";
const REQUIRED_RUNTIME_FILES = [
  "dist/index.js",
  "dist/index.js.map",
  INVENTORY_ENTRY,
  `${INVENTORY_ENTRY}.map`,
];
const HEX = /^[0-9a-f]{64}$/u;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/u;

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function compactDigest(value) {
  return sha256(Buffer.from(JSON.stringify(value), "utf8"));
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
  if (!exactKeys(value.entries, ["extension", "pluginInventory"])) return false;
  if (value.entries.extension !== EXTENSION_ENTRY || value.entries.pluginInventory !== INVENTORY_ENTRY) return false;
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

function regularNoLinks(root, target) {
  try {
    assertNoLinksPath(root, target, "file");
    return true;
  } catch {
    return false;
  }
}

function walkRegularFiles(root) {
  const output = [];
  function visit(directory, relativeDirectory) {
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
  }
  visit(root, "");
  return output;
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

function readContainedFile(packageRoot, relativePath) {
  const target = path.join(packageRoot, ...relativePath.split("/"));
  assertNoLinksPath(packageRoot, target, "file");
  return fs.readFileSync(target);
}

function readPackageIdentity(packageRoot) {
  const parsed = JSON.parse(readContainedFile(packageRoot, "package.json").toString("utf8"));
  const value = { name: parsed.name, version: parsed.version, type: parsed.type };
  if (!validPackage(value)) throw new Error("invalid package identity");
  return value;
}

function readTypeScriptVersion(packageRoot) {
  const require = createRequire(path.join(packageRoot, "package.json"));
  const packageJsonPath = require.resolve("typescript/package.json");
  const parsed = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
  if (typeof parsed.version !== "string" || parsed.version.length === 0) throw new Error("invalid TypeScript identity");
  return parsed.version;
}

function readSourceRecords(packageRoot) {
  const sourceRoot = path.join(packageRoot, "src");
  assertNoLinksPath(packageRoot, sourceRoot, "directory");
  const paths = walkRegularFiles(sourceRoot)
    .filter((relative) => relative.endsWith(".ts"))
    .map((relative) => `src/${relative}`)
    .sort(bytewiseCompare);
  return paths.map((sourcePath) => ({ path: sourcePath, sha256: sha256(readContainedFile(packageRoot, sourcePath)) }));
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

export function collectCompilationIdentity(packageRoot) {
  if (typeof packageRoot !== "string" || packageRoot.length === 0) throw new TypeError("packageRoot must be a non-empty string");
  const root = path.resolve(packageRoot);
  const configBytes = readContainedFile(root, CONFIG_PATH);
  validateRuntimeConfig(configBytes);
  const lockBytes = readContainedFile(root, LOCK_PATH);
  const packageIdentity = readPackageIdentity(root);
  const compiler = {
    typescriptVersion: readTypeScriptVersion(root),
    configPath: CONFIG_PATH,
    configSha256: sha256(configBytes),
    dependencyLockPath: LOCK_PATH,
    dependencyLockSha256: sha256(lockBytes),
  };
  const sources = readSourceRecords(root);
  return { package: packageIdentity, compiler, sources, sourceDigest: compactDigest({ package: packageIdentity, compiler, sources }) };
}

function failure(category, reason) {
  return { ok: false, category, reason };
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
 * @property {{extension: "picc/index.js", pluginInventory: "dist/plugin-inventory-cli.js"}} entries
 */
/** @typedef {{extensionPath: string, pluginInventoryPath: string}} RuntimeEntries */
/** @typedef {{ok: true, manifest: RuntimeManifestV1, entries: RuntimeEntries} | {ok: false, category: "missing" | "source-stale" | "corrupt" | "version-mismatch", reason: string}} VerifyResult */

/** @param {{packageRoot: string, checkSource?: boolean, distDirectory?: string}} options @returns {VerifyResult} */
export function verifyCompiledRuntime({ packageRoot, checkSource = false, distDirectory }) {
  if (typeof packageRoot !== "string" || packageRoot.length === 0) throw new TypeError("packageRoot must be a non-empty string");
  if (typeof checkSource !== "boolean") throw new TypeError("checkSource must be a boolean");
  if (distDirectory !== undefined && (typeof distDirectory !== "string" || distDirectory.length === 0)) throw new TypeError("distDirectory must be a non-empty string");

  const root = path.resolve(packageRoot);
  const dist = path.resolve(distDirectory ?? path.join(root, "dist"));
  let distStat;
  try {
    distStat = fs.lstatSync(dist);
  } catch (error) {
    return isMissingError(error)
      ? failure("missing", "The compiled PiCC runtime is missing.")
      : failure("corrupt", "The compiled PiCC runtime cannot be accessed safely.");
  }
  if (distStat.isSymbolicLink() || !distStat.isDirectory()) return failure("corrupt", "The compiled PiCC runtime directory is invalid.");

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
    manifest = JSON.parse(fs.readFileSync(manifestPath).toString("utf8"));
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
    actualDistFiles = walkRegularFiles(dist).filter((relative) => relative !== MANIFEST_NAME).sort(bytewiseCompare);
  } catch {
    return failure("corrupt", "The compiled PiCC runtime contains an inaccessible or invalid path.");
  }
  const recordedDistFiles = manifest.files.filter((record) => record.path.startsWith("dist/")).map((record) => record.path.slice(5));
  if (JSON.stringify(actualDistFiles) !== JSON.stringify(recordedDistFiles)) return failure("corrupt", "The compiled PiCC runtime has missing or unexpected files.");

  const fileSet = new Set(manifest.files.map((record) => record.path));
  const sourcePaths = new Set(manifest.sources.map((record) => record.path));
  for (const record of manifest.files) {
    const physical = physicalRuntimePath(root, dist, record.path);
    if (!regularNoLinks(record.path.startsWith("dist/") ? dist : root, physical)) return failure("corrupt", "A compiled PiCC runtime file is missing or invalid.");
    let bytes;
    try {
      bytes = fs.readFileSync(physical);
    } catch {
      return failure("corrupt", "A compiled PiCC runtime file changed or cannot be accessed safely.");
    }
    if (sha256(bytes) !== record.sha256) return failure("corrupt", "A compiled PiCC runtime file failed its integrity check.");
    if (record.path.endsWith(".js") && record.path.startsWith("dist/") && !fileSet.has(`${record.path}.map`)) return failure("corrupt", "A compiled PiCC runtime source map is missing.");
    if (record.path.endsWith(".js.map") && (!fileSet.has(record.path.slice(0, -4)) || !mapIsSafe(root, record.path, bytes, sourcePaths))) {
      return failure("corrupt", "A compiled PiCC runtime source map is invalid.");
    }
  }

  if (checkSource) {
    let current;
    try {
      current = collectCompilationIdentity(root);
    } catch {
      return failure("source-stale", "The source checkout compilation inputs changed or are invalid.");
    }
    if (current.sourceDigest !== manifest.sourceDigest) return failure("source-stale", "The source checkout changed after the compiled runtime was built.");
  } else {
    let currentPackage;
    try {
      currentPackage = readPackageIdentity(root);
    } catch {
      return failure("version-mismatch", "The installed PiCC package identity is invalid.");
    }
    if (JSON.stringify(currentPackage) !== JSON.stringify(manifest.package)) return failure("version-mismatch", "The installed PiCC runtime does not match the package identity.");
  }

  return { ok: true, manifest, entries: { extensionPath: manifest.entries.extension, pluginInventoryPath: manifest.entries.pluginInventory } };
}

/**
 * @typedef {{ok: true, mode: "compiled", entries: RuntimeEntries, manifest: RuntimeManifestV1, notice: null}
 * | {ok: true, mode: "source", entries: RuntimeEntries, notice: {category: "missing" | "source-stale", message: string}}
 * | {ok: false, category: "missing" | "corrupt" | "version-mismatch", reason: string}} SelectionResult
 */
/** @param {{packageRoot: string, installationKind: "installed" | "source"}} options @returns {SelectionResult} */
export function selectPiccRuntime({ packageRoot, installationKind }) {
  if (installationKind !== "installed" && installationKind !== "source") throw new TypeError("installationKind must be 'installed' or 'source'");
  const verified = verifyCompiledRuntime({ packageRoot, checkSource: installationKind === "source" });
  if (verified.ok) return { ok: true, mode: "compiled", entries: verified.entries, manifest: verified.manifest, notice: null };
  if (installationKind === "source" && (verified.category === "missing" || verified.category === "source-stale")) {
    const message = verified.category === "missing"
      ? "PiCC is using TypeScript source because the compiled runtime is missing. Run `npm run build` from the PiCC checkout root, then exit and relaunch PiCC to restore compiled startup."
      : "PiCC is using TypeScript source because the compiled runtime does not match this checkout. Run `npm run build` from the PiCC checkout root, then exit and relaunch PiCC; `/reload` cannot switch runtime representation.";
    return { ok: true, mode: "source", entries: { extensionPath: SOURCE_EXTENSION_ENTRY, pluginInventoryPath: SOURCE_INVENTORY_ENTRY }, notice: { category: verified.category, message } };
  }
  const reason = installationKind === "installed"
    ? `The installed PiCC runtime is ${verified.category === "missing" ? "missing" : verified.category === "version-mismatch" ? "version-incoherent" : "damaged"}. Update or reinstall PiCC, then relaunch.`
    : "The source-checkout compiled runtime is damaged. Run `npm run build` from the PiCC checkout root, then exit and relaunch PiCC.";
  return { ok: false, category: verified.category, reason };
}

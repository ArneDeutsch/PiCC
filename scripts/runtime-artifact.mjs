import { createHash } from "node:crypto";
import path from "node:path";
import { inspectTarball } from "./tarball-inspect.mjs";

const MANIFEST_PATH = "dist/picc-runtime.json";
const EXTENSION_ENTRY = "picc/index.js";
const INVENTORY_ENTRY = "dist/plugin-inventory-cli.js";
const REQUIRED_RUNTIME_FILES = [
  "dist/index.js",
  "dist/index.js.map",
  INVENTORY_ENTRY,
  `${INVENTORY_ENTRY}.map`,
];
const HEX = /^[0-9a-f]{64}$/u;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/u;
const JSON_LIMITS = Object.freeze({ package: 1024 * 1024, manifest: 8 * 1024 * 1024, map: 8 * 1024 * 1024 });
const UTF8 = new TextDecoder("utf-8", { fatal: true });

function fail(invariant) {
  throw new Error(`Release artifact invariant violated: ${invariant}.`);
}

function exactKeys(value, keys) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function validPath(value) {
  return typeof value === "string" && value.length > 0 && value === value.normalize("NFC")
    && !CONTROL.test(value) && !value.includes("\\") && !value.startsWith("/") && !/^[A-Za-z]:/u.test(value)
    && value.split("/").every((part) => part.length > 0 && part !== "." && part !== "..");
}

function compare(left, right) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function validRecords(value) {
  if (!Array.isArray(value)) return false;
  const folded = new Set();
  let previous;
  for (const record of value) {
    if (!exactKeys(record, ["path", "sha256"]) || !validPath(record.path) || !HEX.test(record.sha256)) return false;
    if (previous !== undefined && compare(previous, record.path) >= 0) return false;
    previous = record.path;
    const fold = record.path.toUpperCase().toLowerCase();
    if (folded.has(fold)) return false;
    folded.add(fold);
  }
  return true;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function digest(value) {
  return sha256(Buffer.from(JSON.stringify(value), "utf8"));
}

function parseJson(content, label, maxBytes) {
  if (content.length > maxBytes) fail(`${label} exceeds its metadata ceiling`);
  let text;
  try { text = UTF8.decode(content); }
  catch { fail(`${label} is not valid UTF-8`); }
  try { return JSON.parse(text); }
  catch { fail(`${label} is malformed JSON`); }
}

function validateExpectedPackage(value) {
  if (!exactKeys(value, ["name", "version", "type"]) || value.name !== "@arnedeutsch/picc"
      || typeof value.version !== "string" || value.version.length === 0 || value.type !== "module") {
    throw new TypeError("expectedPackage must be the explicit @arnedeutsch/picc package identity");
  }
}

function validateManifest(value) {
  if (value !== null && typeof value === "object" && !Array.isArray(value)
      && Object.hasOwn(value, "schemaVersion") && Number.isSafeInteger(value.schemaVersion)
      && value.schemaVersion > 0 && value.schemaVersion !== 1) {
    fail("runtime identity uses an unsupported schema version");
  }
  if (!exactKeys(value, ["schemaVersion", "package", "compiler", "sources", "sourceDigest", "files", "runtimeDigest", "entries"])
      || value.schemaVersion !== 1 || !exactKeys(value.package, ["name", "version", "type"])
      || typeof value.package.name !== "string" || value.package.name.length === 0
      || typeof value.package.version !== "string" || value.package.version.length === 0
      || typeof value.package.type !== "string" || value.package.type.length === 0
      || !exactKeys(value.compiler, ["typescriptVersion", "configPath", "configSha256", "dependencyLockPath", "dependencyLockSha256"])
      || typeof value.compiler.typescriptVersion !== "string" || value.compiler.typescriptVersion.length === 0
      || value.compiler.configPath !== "tsconfig.runtime.json" || !HEX.test(value.compiler.configSha256)
      || value.compiler.dependencyLockPath !== "package-lock.json" || !HEX.test(value.compiler.dependencyLockSha256)
      || !validRecords(value.sources) || !value.sources.every((record) => record.path.startsWith("src/") && record.path.endsWith(".ts"))
      || !validRecords(value.files) || !HEX.test(value.sourceDigest) || !HEX.test(value.runtimeDigest)) {
    fail("runtime identity is malformed for schema version 1");
  }
  if (!exactKeys(value.entries, ["extension", "pluginInventory"])
      || value.entries.extension !== EXTENSION_ENTRY || value.entries.pluginInventory !== INVENTORY_ENTRY) {
    fail("runtime identity has invalid fixed entrypoints");
  }
  const paths = new Set(value.files.map((record) => record.path));
  if (!paths.has(EXTENSION_ENTRY) || !REQUIRED_RUNTIME_FILES.every((required) => paths.has(required))) {
    fail("runtime identity is missing a required runtime record");
  }
  if (!value.files.every((record) => record.path === EXTENSION_ENTRY
      || (record.path.startsWith("dist/") && (record.path.endsWith(".js") || record.path.endsWith(".js.map"))))) {
    fail("runtime identity contains an invalid generated record");
  }
}

function normalizePolicy(policy) {
  if (!exactKeys(policy, ["files", "prefixes"]) || !Array.isArray(policy.files) || !Array.isArray(policy.prefixes)) {
    throw new TypeError("filePolicy must contain files and prefixes arrays");
  }
  const files = new Set();
  const folds = new Set();
  for (const file of policy.files) {
    if (!validPath(file) || files.has(file)) throw new TypeError("filePolicy contains an invalid or duplicate file");
    const fold = file.toUpperCase().toLowerCase();
    if (folds.has(fold)) throw new TypeError("filePolicy contains a case collision");
    files.add(file);
    folds.add(fold);
  }
  const prefixes = [];
  const prefixFolds = new Set();
  for (const prefix of policy.prefixes) {
    if (typeof prefix !== "string" || !prefix.endsWith("/") || !validPath(prefix.slice(0, -1))) {
      throw new TypeError("filePolicy contains an invalid prefix");
    }
    const fold = prefix.toUpperCase().toLowerCase();
    if (prefixFolds.has(fold) || folds.has(prefix.slice(0, -1).toUpperCase().toLowerCase())) {
      throw new TypeError("filePolicy contains a duplicate or case-colliding entry");
    }
    prefixFolds.add(fold);
    prefixes.push(prefix);
  }
  return { files, prefixes };
}

function verifyNoUnexpectedPolicyFiles(files, policy) {
  for (const name of files.keys()) {
    if (!policy.files.has(name) && !policy.prefixes.some((prefix) => name.startsWith(prefix))) {
      fail("archive contains a file outside the product policy");
    }
  }
}

function verifyRequiredPolicyFiles(files, policy) {
  for (const required of policy.files) if (!files.has(required)) fail("a required non-runtime policy file is missing");
}

function verifyMap(manifestPath, content, sourcePaths) {
  const map = parseJson(content, "runtime source map", JSON_LIMITS.map);
  if (map === null || typeof map !== "object" || Array.isArray(map) || map.version !== 3 || !Array.isArray(map.sources)
      || map.file !== path.posix.basename(manifestPath, ".map") || (Object.hasOwn(map, "sourceRoot") && map.sourceRoot !== "")) {
    fail("runtime source map has an invalid shape");
  }
  const conceptualDirectory = path.posix.dirname(manifestPath);
  const expectedSource = `src/${manifestPath.slice("dist/".length, -".js.map".length)}.ts`;
  if (map.sources.length !== 1) fail("runtime source map does not identify exactly one compiled source");
  const [source] = map.sources;
  if (typeof source !== "string" || source.length === 0 || source !== source.normalize("NFC") || CONTROL.test(source)
      || source.includes("\\") || source.startsWith("/") || /^[A-Za-z]:/u.test(source) || /^[a-z][a-z0-9+.-]*:/iu.test(source)) {
    fail("runtime source map contains an unsafe source path");
  }
  const resolved = path.posix.normalize(path.posix.join(conceptualDirectory, source));
  if (!validPath(resolved) || resolved !== expectedSource || !sourcePaths.has(resolved)) {
    fail("runtime source map does not resolve to its exact recorded source");
  }
}

function productionLoaderDeclared(packageJson) {
  for (const field of ["dependencies", "optionalDependencies", "peerDependencies"]) {
    const declarations = packageJson?.[field];
    if (declarations !== undefined && (declarations === null || typeof declarations !== "object" || Array.isArray(declarations))) {
      fail(`package ${field} has an invalid shape`);
    }
    if (declarations !== undefined && Object.keys(declarations).some((name) => name.toLowerCase() === "jiti")) return true;
  }
  return false;
}

export function verifyRuntimeArtifact({ archiveBytes, expectedPackage, expectedSourceDigest, filePolicy, limits } = {}) {
  validateExpectedPackage(expectedPackage);
  if (typeof expectedSourceDigest !== "string" || !HEX.test(expectedSourceDigest)) {
    throw new TypeError("expectedSourceDigest must be a lowercase SHA-256 digest");
  }
  const policy = normalizePolicy(filePolicy);
  const inspected = inspectTarball(archiveBytes, { limits });
  if (inspected.root !== "package") fail("npm package root is not canonical");
  verifyNoUnexpectedPolicyFiles(inspected.files, policy);

  const packageBytes = inspected.files.get("package.json");
  if (packageBytes === undefined) fail("package metadata is missing");
  const packageJson = parseJson(packageBytes, "package metadata", JSON_LIMITS.package);
  const packageIdentity = { name: packageJson?.name, version: packageJson?.version, type: packageJson?.type };
  if (JSON.stringify(packageIdentity) !== JSON.stringify(expectedPackage)) fail("package identity does not match the expected product");
  if (productionLoaderDeclared(packageJson)) fail("package declares a direct production TypeScript runtime loader");

  const manifestBytes = inspected.files.get(MANIFEST_PATH);
  if (manifestBytes === undefined) fail("runtime identity is missing");
  const manifest = parseJson(manifestBytes, "runtime identity", JSON_LIMITS.manifest);
  validateManifest(manifest);
  if (JSON.stringify(manifest.package) !== JSON.stringify(expectedPackage)) fail("runtime and package identities do not match");
  if (manifest.sourceDigest !== expectedSourceDigest) fail("runtime source identity is stale");
  if (digest({ package: manifest.package, compiler: manifest.compiler, sources: manifest.sources }) !== manifest.sourceDigest) {
    fail("runtime source digest is inconsistent");
  }
  if (digest(manifest.files) !== manifest.runtimeDigest) fail("generated runtime digest is inconsistent");

  const recordedRuntime = new Set(manifest.files.map((record) => record.path));
  const archiveRuntime = [...inspected.files.keys()].filter((name) =>
    (name.startsWith("dist/") && name !== MANIFEST_PATH)
    || (name.startsWith("picc/") && (name.endsWith(".js") || name.endsWith(".js.map"))));
  if (archiveRuntime.some((name) => !recordedRuntime.has(name))) fail("generated runtime contents contain unexpected files");
  if ([...recordedRuntime].some((name) => !inspected.files.has(name))) fail("generated runtime contents are missing files");

  const sourcePaths = new Set(manifest.sources.map((record) => record.path));
  const archiveSources = [...inspected.files.keys()].filter((name) => name.startsWith("src/"));
  if (archiveSources.length !== sourcePaths.size || archiveSources.some((name) => !sourcePaths.has(name))) {
    fail("retained source set does not exactly match the runtime identity");
  }
  for (const record of manifest.sources) {
    const content = inspected.files.get(record.path);
    if (content === undefined || sha256(content) !== record.sha256) fail("retained source failed its integrity check");
  }
  for (const record of manifest.files) {
    const content = inspected.files.get(record.path);
    if (content === undefined || sha256(content) !== record.sha256) fail("generated runtime failed its integrity check");
  }
  for (const record of manifest.files) {
    if (record.path.endsWith(".js") && record.path.startsWith("dist/") && !recordedRuntime.has(`${record.path}.map`)) {
      fail("generated JavaScript is missing its source map");
    }
    if (record.path.endsWith(".js.map")) {
      if (!recordedRuntime.has(record.path.slice(0, -4))) fail("runtime contains an orphan source map");
      verifyMap(record.path, inspected.files.get(record.path), sourcePaths);
    }
  }
  verifyRequiredPolicyFiles(inspected.files, policy);

  return { package: packageIdentity, manifest, files: inspected.files };
}

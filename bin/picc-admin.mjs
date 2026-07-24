import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const PI_SUITE_PACKAGES = Object.freeze([
  "@earendil-works/pi-agent-core",
  "@earendil-works/pi-ai",
  "@earendil-works/pi-coding-agent",
  "@earendil-works/pi-tui",
]);
export const VALIDATION_MODES = Object.freeze({
  COHERENT_BOOTSTRAP: "coherent-bootstrap",
  STRICT_EXACT: "strict-exact",
});
export const SAFE_ADMIN_ERROR_CODE = "PICC_SAFE_ADMIN_ERROR";

export function safeAdministrativeError(message) {
  const error = new Error(message);
  error.code = SAFE_ADMIN_ERROR_CODE;
  error.safeMessage = message;
  return error;
}

export function isSafeAdministrativeError(value) {
  return value?.code === SAFE_ADMIN_ERROR_CODE
    && typeof value.safeMessage === "string"
    && value.safeMessage.length > 0
    && value.safeMessage.length <= 500
    && !/[\r\n]/.test(value.safeMessage);
}

const VERSION_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const PUBLIC_REGISTRY_RE = /^https:\/\/registry\.npmjs\.org\/picc\/-\/picc-(\d+\.\d+\.\d+)\.tgz$/;
const MAX_NODE_MODULES_DIRS = 4096;
const MAX_NODE_MODULES_DEPTH = 64;

export function parseStableExactVersion(value) {
  if (typeof value !== "string") return undefined;
  const match = VERSION_RE.exec(value);
  if (!match) return undefined;
  // Decimal strings avoid silently rounding versions above Number.MAX_SAFE_INTEGER.
  return Object.freeze({ raw: value, parts: Object.freeze(match.slice(1)) });
}

function compareDecimal(left, right) {
  return left.length === right.length ? (left < right ? -1 : left > right ? 1 : 0) : left.length < right.length ? -1 : 1;
}

export function compareStableVersions(left, right) {
  const a = typeof left === "string" ? parseStableExactVersion(left) : left;
  const b = typeof right === "string" ? parseStableExactVersion(right) : right;
  if (!a || !b) throw new TypeError("PiCC requires stable exact semantic versions");
  for (let index = 0; index < 3; index += 1) {
    const compared = compareDecimal(a.parts[index], b.parts[index]);
    if (compared !== 0) return compared;
  }
  return 0;
}

function readJson(filename) {
  try {
    return JSON.parse(fs.readFileSync(filename, "utf8"));
  } catch {
    return undefined;
  }
}

export function canonicalPath(filename) {
  const resolved = fs.realpathSync.native(filename);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

export function isPathInside(candidate, parent) {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

export function findPackageRoot(moduleUrl = import.meta.url) {
  let current = path.dirname(fileURLToPath(moduleUrl));
  for (;;) {
    const manifest = readJson(path.join(current, "package.json"));
    if (manifest?.name === "picc") return canonicalPath(current);
    const parent = path.dirname(current);
    if (parent === current) throw new Error("PiCC package metadata is unavailable");
    current = parent;
  }
}

function executableCandidates(relativeCandidates) {
  const executableDir = path.dirname(canonicalPath(process.execPath));
  return relativeCandidates.map((candidate) => path.resolve(executableDir, candidate));
}

function trustedWindowsUserPaths() {
  if (process.platform !== "win32") return undefined;
  const supplied = os.userInfo().homedir;
  if (!path.isAbsolute(supplied)) throw new Error("The OS user profile is unavailable");
  const home = canonicalPath(supplied);
  const derive = (...segments) => {
    const candidate = canonicalPath(path.join(home, ...segments));
    if (!isPathInside(candidate, home)) throw new Error("The OS user profile is malformed");
    return candidate;
  };
  return Object.freeze({
    home,
    appData: derive("AppData", "Roaming"),
    localAppData: derive("AppData", "Local"),
    temp: derive("AppData", "Local", "Temp"),
  });
}

function trustedWindowsSystemRoot() {
  if (process.platform !== "win32") return undefined;
  const fixed = "C:\\Windows";
  try {
    const actual = canonicalPath(fixed);
    return actual === path.resolve(fixed).toLowerCase() && fs.statSync(actual).isDirectory() ? actual : undefined;
  } catch {
    return undefined;
  }
}

export function discoverTrustedNpmCli() {
  const candidates = executableCandidates([
    "node_modules/npm/bin/npm-cli.js",
    "../lib/node_modules/npm/bin/npm-cli.js",
    "../node_modules/npm/bin/npm-cli.js",
  ]);
  return candidates.find((candidate) => fs.statSync(candidate, { throwIfNoEntry: false })?.isFile());
}

export function discoverTrustedGit() {
  const candidates = process.platform === "win32"
    ? [
        path.join(trustedWindowsUserPaths().localAppData, "Programs", "Git", "cmd", "git.exe"),
        "C:\\Program Files\\Git\\cmd\\git.exe",
        "C:\\Program Files (x86)\\Git\\cmd\\git.exe",
      ]
    : ["/usr/bin/git", "/usr/local/bin/git", "/opt/homebrew/bin/git"];
  return candidates.find((candidate) => path.isAbsolute(candidate) && fs.statSync(candidate, { throwIfNoEntry: false })?.isFile());
}

function trustedTemporaryRoot() {
  const windows = process.platform === "win32" ? trustedWindowsUserPaths() : undefined;
  const systemRoot = trustedWindowsSystemRoot();
  const candidates = process.platform === "win32"
    ? [windows.temp, ...(systemRoot ? [path.join(systemRoot, "Temp")] : [])]
    : ["/tmp", "/var/tmp"];
  for (const candidate of candidates) {
    try {
      if (path.isAbsolute(candidate) && fs.statSync(candidate).isDirectory()) return canonicalPath(candidate);
    } catch { /* try the next fixed platform location */ }
  }
  throw new Error("A trusted administrative temporary directory is unavailable");
}

const TRUSTED_TEMP_ROOT = trustedTemporaryRoot();
let administrationRoot;
let administrationUsers = 0;

function ensureAdministrationRoot() {
  if (!administrationRoot) administrationRoot = fs.mkdtempSync(path.join(TRUSTED_TEMP_ROOT, "picc-administration-"));
  return administrationRoot;
}

export function administrativeEnvironment() {
  const root = ensureAdministrationRoot();
  const home = path.join(root, "home");
  const temp = path.join(root, "temp");
  const windows = process.platform === "win32" ? trustedWindowsUserPaths() : undefined;
  const appData = windows?.appData ?? path.join(home, "AppData", "Roaming");
  const localAppData = windows?.localAppData ?? path.join(home, "AppData", "Local");
  for (const directory of [home, temp, path.join(root, "npm-cache")]) fs.mkdirSync(directory, { recursive: true });
  const env = {
    HOME: home,
    USERPROFILE: home,
    APPDATA: appData,
    LOCALAPPDATA: localAppData,
    TEMP: temp,
    TMP: temp,
    TMPDIR: temp,
    npm_config_cache: path.join(root, "npm-cache"),
    npm_config_userconfig: path.join(root, "npmrc"),
    npm_config_globalconfig: path.join(root, "global-npmrc"),
    NO_PROXY: "*",
    no_proxy: "*",
    PATH: [path.dirname(canonicalPath(process.execPath)), path.dirname(discoverTrustedGit() ?? process.execPath)].join(path.delimiter),
  };
  const systemRoot = trustedWindowsSystemRoot();
  if (systemRoot) {
    env.SystemRoot = systemRoot;
    env.WINDIR = systemRoot;
  }
  return env;
}

export function wireChildLifecycle(child, { onSpawnError, onExitCode, onSignal }) {
  let spawnFailed = false;
  child.once("error", () => {
    spawnFailed = true;
    onSpawnError();
  });
  child.once("exit", (code, signal) => {
    if (spawnFailed) return;
    if (signal) onSignal(signal);
    else onExitCode(code ?? 1);
  });
}

export function cleanupAdministrativeEnvironment() {
  if (!administrationRoot || administrationUsers !== 0) return false;
  const root = administrationRoot;
  administrationRoot = undefined;
  fs.rmSync(root, { recursive: true, force: true });
  return !fs.existsSync(root);
}

function trustedCwd(cwd, trustedRoots) {
  const actual = canonicalPath(cwd);
  const roots = trustedRoots.map(canonicalPath);
  if (!roots.some((root) => isPathInside(actual, root))) throw new Error("Administrative cwd is outside trusted roots");
  return actual;
}

export function runAdministrativeChild(executable, args, { cwd, trustedRoots, stdio = "pipe" } = {}) {
  if (!path.isAbsolute(executable)) throw new Error("Administrative executables must be absolute");
  const root = ensureAdministrationRoot();
  const defaultCwd = path.dirname(canonicalPath(process.execPath));
  const childCwd = trustedCwd(cwd ?? defaultCwd, trustedRoots ?? [defaultCwd, root]);
  administrationUsers += 1;
  let child;
  try {
    child = spawn(executable, args, {
      cwd: childCwd,
      env: administrativeEnvironment(),
      shell: false,
      stdio,
      windowsHide: true,
    });
  } catch (error) {
    administrationUsers -= 1;
    cleanupAdministrativeEnvironment();
    throw error;
  }
  child.once("close", () => {
    administrationUsers -= 1;
    cleanupAdministrativeEnvironment();
  });
  return child;
}

export function runTrustedNpm(args, options) {
  const npmCli = discoverTrustedNpmCli();
  if (!npmCli) throw new Error("Trusted npm CLI is unavailable");
  return runAdministrativeChild(process.execPath, [npmCli, ...args], options);
}

function runAdministrativeSync(executable, args, cwd) {
  const root = ensureAdministrationRoot();
  try {
    return spawnSync(executable, args, {
      cwd: trustedCwd(cwd, [cwd]),
      env: administrativeEnvironment(),
      encoding: "utf8",
      shell: false,
      windowsHide: true,
    });
  } finally {
    cleanupAdministrativeEnvironment();
    if (administrationRoot === root) cleanupAdministrativeEnvironment();
  }
}

export function discoverGlobalNpmRoot() {
  const npmCli = discoverTrustedNpmCli();
  if (!npmCli) return undefined;
  const result = runAdministrativeSync(process.execPath, [npmCli, "root", "--global"], path.dirname(canonicalPath(process.execPath)));
  const output = result.status === 0 ? result.stdout.trim() : "";
  try {
    return path.isAbsolute(output) && fs.statSync(output, { throwIfNoEntry: false })?.isDirectory() ? canonicalPath(output) : undefined;
  } catch {
    return undefined;
  }
}

export function runTrustedGit(args, options) {
  const git = discoverTrustedGit();
  if (!git) throw new Error("Trusted Git is unavailable");
  return runAdministrativeChild(git, args, options);
}

function gitOwnedCheckout(packageRoot) {
  const git = discoverTrustedGit();
  if (!git) return false;
  const root = canonicalPath(packageRoot);
  const result = runAdministrativeSync(git, ["-C", root, "rev-parse", "--show-toplevel"], root);
  if (result.status !== 0) return false;
  try {
    const top = canonicalPath(result.stdout.trim());
    return isPathInside(root, top);
  } catch {
    return false;
  }
}

function findContainingNodeModules(packageRoot) {
  let current = canonicalPath(packageRoot);
  for (;;) {
    const parent = path.dirname(current);
    if (path.basename(parent) === "node_modules") return parent;
    if (path.basename(path.dirname(parent)) === "node_modules" && path.basename(parent).startsWith("@")) return path.dirname(parent);
    if (parent === current) return undefined;
    current = parent;
  }
}

function registryProof(packageRoot, version) {
  const nodeModules = findContainingNodeModules(packageRoot);
  if (!nodeModules) return false;
  const lock = readJson(path.join(nodeModules, ".package-lock.json"));
  const entry = lock?.packages?.["node_modules/picc"];
  const match = typeof entry?.resolved === "string" ? PUBLIC_REGISTRY_RE.exec(entry.resolved) : undefined;
  return entry?.version === version && match?.[1] === version && typeof entry?.integrity === "string" && entry.integrity.length > 0;
}

export function classifyInstallation({ packageRoot, globalRoot } = {}) {
  let root;
  try {
    root = canonicalPath(packageRoot ?? findPackageRoot());
  } catch {
    return "unknown/other";
  }
  const manifest = readJson(path.join(root, "package.json"));
  if (!manifest || !parseStableExactVersion(manifest.version)) return "unknown/other";
  if (gitOwnedCheckout(root)) return "source";
  if (globalRoot) {
    try {
      const nodeModules = findContainingNodeModules(root);
      const expectedGlobalRoot = canonicalPath(globalRoot);
      if (nodeModules && canonicalPath(nodeModules) === expectedGlobalRoot && isPathInside(root, expectedGlobalRoot)) {
        return registryProof(root, manifest.version) ? "verified public-registry global npm" : "unknown/other";
      }
    } catch {
      return "unknown/other";
    }
  }
  const nodeModules = findContainingNodeModules(root);
  if (!nodeModules) return "unknown/other";
  try {
    return readJson(path.join(path.dirname(nodeModules), "package.json")) && isPathInside(root, canonicalPath(nodeModules))
      ? "known local package"
      : "unknown/other";
  } catch {
    return "unknown/other";
  }
}

function declarationVersion(value) {
  const exact = parseStableExactVersion(value);
  if (exact) return { exact: true, version: exact.raw };
  if (typeof value === "string" && value.startsWith("^")) {
    const parsed = parseStableExactVersion(value.slice(1));
    if (parsed) return { exact: false, version: parsed.raw };
  }
  return undefined;
}

function satisfiesDeclaration(version, declaration) {
  if (declaration.exact) return version === declaration.version;
  const actual = parseStableExactVersion(version);
  const minimum = parseStableExactVersion(declaration.version);
  if (!actual || !minimum || compareStableVersions(actual, minimum) < 0) return false;
  const [major, minor, patch] = minimum.parts;
  if (major !== "0") return actual.parts[0] === major;
  if (minor !== "0") return actual.parts[0] === "0" && actual.parts[1] === minor;
  return actual.parts[0] === "0" && actual.parts[1] === "0" && actual.parts[2] === patch;
}

function suitePath(nodeModules, name) {
  return path.join(nodeModules, ...name.split("/"));
}

function candidateNodeModules(packageRoot) {
  const root = canonicalPath(packageRoot);
  const candidates = [];
  const owned = path.join(root, "node_modules");
  if (fs.statSync(owned, { throwIfNoEntry: false })?.isDirectory()) candidates.push(canonicalPath(owned));
  // npm hoists dependencies to the node_modules that physically contains picc.
  // Do not continue into unrelated ancestors (notably a checkout that stores worktrees below itself).
  const containing = findContainingNodeModules(root);
  if (containing && fs.statSync(containing, { throwIfNoEntry: false })?.isDirectory()) candidates.push(canonicalPath(containing));
  return [...new Set(candidates)];
}

function installedOccurrence(name, logicalRoot, admissibleNodeModules) {
  try {
    const root = canonicalPath(logicalRoot);
    if (!admissibleNodeModules.some((nodeModules) => isPathInside(root, nodeModules))) return undefined;
    const manifest = readJson(path.join(root, "package.json"));
    return manifest?.name === name && parseStableExactVersion(manifest.version) ? { name, root, version: manifest.version } : undefined;
  } catch {
    return undefined;
  }
}

function resolveInstalledSuite(packageRoot, nodeModulesRoots) {
  const resolved = new Map();
  for (const name of PI_SUITE_PACKAGES) {
    let occurrence;
    for (const nodeModules of nodeModulesRoots) {
      const candidate = suitePath(nodeModules, name);
      if (!fs.statSync(candidate, { throwIfNoEntry: false })?.isDirectory()) continue;
      occurrence = installedOccurrence(name, candidate, nodeModulesRoots);
      if (occurrence) break;
      return undefined;
    }
    if (!occurrence) return undefined;
    resolved.set(name, occurrence.root);
  }
  return resolved;
}

function validLockPath(relative) {
  if (typeof relative !== "string" || relative.includes("\\")) return undefined;
  if (relative === "") return "";
  if (path.posix.isAbsolute(relative) || /^[A-Za-z]:/.test(relative) || relative.startsWith("//")) return undefined;
  const segments = relative.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) return undefined;
  return segments.join("/");
}

function lockOccurrences(packageRoot, lock, admissibleNodeModules) {
  if (!lock?.packages || typeof lock.packages !== "object" || Array.isArray(lock.packages)) return undefined;
  const occurrences = [];
  for (const [relative, metadata] of Object.entries(lock.packages)) {
    const normalized = validLockPath(relative);
    if (normalized === undefined) return undefined;
    for (const name of PI_SUITE_PACKAGES) {
      if (normalized === `node_modules/${name}` || normalized.endsWith(`/node_modules/${name}`)) {
        const logicalRoot = path.resolve(packageRoot, ...normalized.split("/"));
        const expectedParent = path.resolve(packageRoot, ...normalized.slice(0, -name.length).split("/").filter(Boolean));
        let parent;
        try {
          parent = canonicalPath(expectedParent);
        } catch {
          return undefined;
        }
        if (!admissibleNodeModules.some((root) => isPathInside(parent, root))) return undefined;
        const installed = installedOccurrence(name, logicalRoot, admissibleNodeModules);
        occurrences.push({ name, metadata, installed });
      }
    }
  }
  return occurrences;
}

function scanPhysicalOccurrences(nodeModulesRoots) {
  const pending = nodeModulesRoots.map((root) => ({ root, depth: 0 }));
  const visited = new Set();
  const occurrences = [];
  while (pending.length > 0) {
    const { root, depth } = pending.pop();
    let identity;
    try {
      identity = canonicalPath(root);
    } catch {
      return undefined;
    }
    if (visited.has(identity)) continue;
    if (visited.size >= MAX_NODE_MODULES_DIRS || depth > MAX_NODE_MODULES_DEPTH) return undefined;
    visited.add(identity);
    for (const name of PI_SUITE_PACKAGES) {
      const candidate = suitePath(root, name);
      if (!fs.statSync(candidate, { throwIfNoEntry: false })?.isDirectory()) continue;
      const occurrence = installedOccurrence(name, candidate, nodeModulesRoots);
      if (!occurrence) return undefined;
      occurrences.push(occurrence);
    }
    let entries;
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      return undefined;
    }
    const packageRoots = [];
    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const entryPath = path.join(root, entry.name);
      if (entry.name.startsWith("@")) {
        let scoped;
        try { scoped = fs.readdirSync(entryPath, { withFileTypes: true }); } catch { return undefined; }
        for (const child of scoped) if (child.isDirectory() || child.isSymbolicLink()) packageRoots.push(path.join(entryPath, child.name));
      } else packageRoots.push(entryPath);
    }
    for (const packageRoot of packageRoots) {
      const nested = path.join(packageRoot, "node_modules");
      if (fs.statSync(nested, { throwIfNoEntry: false })?.isDirectory()) pending.push({ root: nested, depth: depth + 1 });
    }
  }
  return { occurrences, scannedNodeModules: visited.size };
}

export function validatePiSuite({ packageRoot = findPackageRoot(), mode } = {}) {
  let root;
  try { root = canonicalPath(packageRoot); } catch { return { ok: false, reason: "PiCC package metadata is invalid" }; }
  const manifest = readJson(path.join(root, "package.json"));
  if (!manifest?.dependencies) return { ok: false, reason: "PiCC package metadata is invalid" };
  const declarations = PI_SUITE_PACKAGES.map((name) => [name, declarationVersion(manifest.dependencies[name])]);
  if (declarations.some(([, declaration]) => !declaration)) return { ok: false, reason: "PiCC has malformed Pi suite declarations" };
  const exactDeclarations = declarations.every(([, declaration]) => declaration.exact);
  const selectedMode = mode ?? (exactDeclarations ? VALIDATION_MODES.STRICT_EXACT : VALIDATION_MODES.COHERENT_BOOTSTRAP);
  if (!Object.values(VALIDATION_MODES).includes(selectedMode)) return { ok: false, reason: "Unknown Pi suite policy" };
  if (selectedMode === VALIDATION_MODES.STRICT_EXACT && !exactDeclarations) return { ok: false, reason: "PiCC requires exact Pi suite declarations" };
  if (new Set(declarations.map(([, declaration]) => declaration.version)).size !== 1 || new Set(declarations.map(([, declaration]) => declaration.exact)).size !== 1) {
    return { ok: false, reason: "PiCC has mixed Pi suite declarations" };
  }
  const source = gitOwnedCheckout(root);
  if (selectedMode === VALIDATION_MODES.COHERENT_BOOTSTRAP && !source) return { ok: false, reason: "Non-source PiCC installs require exact Pi suite declarations" };

  const nodeModulesRoots = candidateNodeModules(root);
  const resolved = resolveInstalledSuite(root, nodeModulesRoots);
  if (!resolved) return { ok: false, reason: "The embedded Pi suite is incomplete" };
  const scan = scanPhysicalOccurrences(nodeModulesRoots);
  if (!scan) return { ok: false, reason: "The installed dependency graph is malformed or too large" };
  const occurrences = [...scan.occurrences];

  const lock = readJson(path.join(root, "package-lock.json"));
  if (source && !lock) return { ok: false, reason: "The source lockfile is missing or malformed" };
  if (lock) {
    const recorded = lockOccurrences(root, lock, nodeModulesRoots);
    if (!recorded) return { ok: false, reason: "The PiCC lockfile is malformed" };
    if (PI_SUITE_PACKAGES.some((name) => !recorded.some((entry) => entry.name === name))) return { ok: false, reason: "The PiCC lockfile has an incomplete Pi suite" };
    for (const entry of recorded) {
      if (!parseStableExactVersion(entry.metadata?.version)) return { ok: false, reason: "The PiCC lockfile has malformed Pi versions" };
      if (!entry.installed || entry.installed.version !== entry.metadata.version) return { ok: false, reason: "The installed Pi suite is stale; run `picc update`" };
      occurrences.push(entry.installed);
    }
  }
  if (occurrences.length === 0) return { ok: false, reason: "The embedded Pi suite is incomplete" };
  const versions = new Set(occurrences.map(({ version }) => version));
  if (versions.size !== 1) return { ok: false, reason: "The installed Pi suite contains mixed versions" };
  const version = occurrences[0].version;
  if (declarations.some(([, declaration]) => !satisfiesDeclaration(version, declaration))) return { ok: false, reason: "The installed Pi suite does not satisfy PiCC's declarations" };
  return { ok: true, version, mode: selectedMode, resolved, source, scannedNodeModules: scan.scannedNodeModules, admissibleNodeModules: nodeModulesRoots };
}

export function resolvePiCli(packageRoot = findPackageRoot()) {
  const suite = validatePiSuite({ packageRoot });
  if (!suite.ok) return suite;
  const codingAgent = suite.resolved.get("@earendil-works/pi-coding-agent");
  const logicalCli = path.join(codingAgent, "dist", "cli.js");
  try {
    const cli = canonicalPath(logicalCli);
    if (!fs.statSync(cli).isFile() || !isPathInside(cli, codingAgent) || !suite.admissibleNodeModules.some((root) => isPathInside(cli, root))) {
      return { ok: false, reason: "The embedded Pi CLI is unavailable" };
    }
    return { ...suite, cli };
  } catch {
    return { ok: false, reason: "The embedded Pi CLI is unavailable" };
  }
}

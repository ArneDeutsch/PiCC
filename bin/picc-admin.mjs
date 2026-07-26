import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

export const PI_SUITE_PACKAGES = Object.freeze([
  "@earendil-works/pi-agent-core",
  "@earendil-works/pi-ai",
  "@earendil-works/pi-coding-agent",
  "@earendil-works/pi-tui",
]);

const VERSION_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export function parseStableExactVersion(value) {
  return typeof value === "string" && VERSION_RE.test(value) ? value : undefined;
}

function compareDecimal(left, right) {
  if (left.length !== right.length) return left.length < right.length ? -1 : 1;
  return left < right ? -1 : left > right ? 1 : 0;
}

export function compareStableVersions(left, right) {
  const a = typeof left === "string" ? VERSION_RE.exec(left) : undefined;
  const b = typeof right === "string" ? VERSION_RE.exec(right) : undefined;
  if (!a || !b) return undefined;
  for (let index = 1; index <= 3; index += 1) {
    const compared = compareDecimal(a[index], b[index]);
    if (compared !== 0) return compared;
  }
  return 0;
}

function readJson(filename) {
  try { return JSON.parse(fs.readFileSync(filename, "utf8")); } catch { return undefined; }
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
    if (readJson(path.join(current, "package.json"))?.name === "picc") return canonicalPath(current);
    const parent = path.dirname(current);
    if (parent === current) throw new Error("PiCC package root is unavailable");
    current = parent;
  }
}

function envPath(env) {
  if (process.platform !== "win32") return env.PATH ?? "";
  const key = Object.keys(env).find((name) => name.toLowerCase() === "path");
  return key ? env[key] ?? "" : "";
}

function executableFile(filename) {
  try {
    if (!fs.statSync(filename).isFile()) return undefined;
    if (process.platform !== "win32") fs.accessSync(filename, fs.constants.X_OK);
    return canonicalPath(filename);
  } catch { return undefined; }
}

export function findExecutableOnPath(name, env = process.env) {
  if (typeof name !== "string" || name.length === 0 || path.isAbsolute(name) || name.includes("/") || name.includes("\\")) return undefined;
  const extensions = process.platform === "win32"
    ? (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";")
      .filter((extension) => [".com", ".exe"].includes(extension.toLowerCase()))
    : [""];
  const hasExtension = process.platform === "win32" && path.extname(name) !== "";
  for (const directory of envPath(env).split(path.delimiter)) {
    if (!directory) continue;
    for (const extension of hasExtension ? [""] : extensions) {
      const found = executableFile(path.join(directory, `${name}${extension}`));
      if (found) return found;
    }
  }
  return undefined;
}

export function discoverTrustedGit(env = process.env) {
  const override = env.PICC_GIT;
  if (override !== undefined) {
    if (process.platform === "win32" && ![".com", ".exe"].includes(path.extname(override).toLowerCase())) return undefined;
    return path.isAbsolute(override) ? executableFile(override) : undefined;
  }
  return findExecutableOnPath("git", env);
}

export function discoverNpmCommand({ env = process.env, execPath = process.execPath } = {}) {
  const candidates = [];
  if (typeof env.npm_execpath === "string" && path.isAbsolute(env.npm_execpath)) candidates.push(env.npm_execpath);
  const nodeDir = path.dirname(execPath);
  candidates.push(
    path.join(nodeDir, "node_modules", "npm", "bin", "npm-cli.js"),
    path.resolve(nodeDir, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
    path.resolve(nodeDir, "..", "node_modules", "npm", "bin", "npm-cli.js"),
  );
  for (const candidate of candidates) {
    const cli = executableFile(candidate);
    if (cli) return { command: canonicalPath(execPath), args: [cli] };
  }
  if (process.platform !== "win32") {
    const npm = findExecutableOnPath("npm", env);
    if (npm) return { command: npm, args: [] };
  }
  return undefined;
}

export function spawnNpm(args, options = {}) {
  const npm = discoverNpmCommand({ env: options.env ?? process.env });
  if (!npm) throw new Error("npm was not found; install npm or run the equivalent npm command directly");
  return spawn(npm.command, [...npm.args, ...args], { shell: false, windowsHide: true, ...options });
}

export function discoverGlobalNpmRoot() {
  const npm = discoverNpmCommand();
  if (!npm) return undefined;
  const result = spawnSync(npm.command, [...npm.args, "root", "--global"], {
    env: process.env, encoding: "utf8", windowsHide: true, shell: false,
  });
  const output = result.status === 0 ? result.stdout?.trim() : "";
  try {
    return output && path.isAbsolute(output) && fs.statSync(output).isDirectory() ? canonicalPath(output) : undefined;
  } catch { return undefined; }
}

export function classifyInstallation({ packageRoot } = {}) {
  try {
    const root = canonicalPath(packageRoot ?? findPackageRoot());
    const git = fs.lstatSync(path.join(root, ".git"), { throwIfNoEntry: false });
    const lock = fs.lstatSync(path.join(root, "package-lock.json"), { throwIfNoEntry: false });
    return git && (git.isFile() || git.isDirectory()) && lock?.isFile() ? "source" : "installed";
  } catch { return "installed"; }
}

function containingNodeModules(packageRoot) {
  let current = canonicalPath(packageRoot);
  for (;;) {
    const parent = path.dirname(current);
    if (path.basename(parent).toLowerCase() === "node_modules") return parent;
    if (path.basename(path.dirname(parent)).toLowerCase() === "node_modules" && path.basename(parent).startsWith("@")) return path.dirname(parent);
    if (parent === current) return undefined;
    current = parent;
  }
}

function admissibleNodeModules(packageRoot) {
  const roots = [];
  try {
    const local = path.join(packageRoot, "node_modules");
    if (fs.statSync(local).isDirectory()) roots.push(canonicalPath(local));
  } catch { /* dependencies may be missing */ }
  const containing = containingNodeModules(packageRoot);
  if (containing) {
    try {
      const canonical = canonicalPath(containing);
      if (!roots.includes(canonical)) roots.push(canonical);
    } catch { /* ignore unusable containing root */ }
  }
  return roots;
}

function resolveSuitePackage(name, roots) {
  for (const nodeModules of roots) {
    const logicalRoot = path.join(nodeModules, ...name.split("/"));
    let logicalStat;
    try { logicalStat = fs.lstatSync(logicalRoot, { throwIfNoEntry: false }); }
    catch { return { problem: "is unreadable" }; }
    if (!logicalStat) continue;
    if (!logicalStat.isDirectory() && !logicalStat.isSymbolicLink()) {
      return { problem: "has an invalid package directory" };
    }
    try {
      const packageRoot = canonicalPath(logicalRoot);
      if (!isPathInside(packageRoot, nodeModules)) return { problem: "escapes its dependency root" };
      const manifestPath = path.join(logicalRoot, "package.json");
      const stat = fs.lstatSync(manifestPath, { throwIfNoEntry: false });
      if (!stat?.isFile() || stat.isSymbolicLink()) return { problem: "has missing or invalid package metadata" };
      const manifest = readJson(manifestPath);
      return manifest
        ? { packageRoot, manifest }
        : { problem: "has unreadable package metadata" };
    } catch { return { problem: "is unreadable" }; }
  }
  return undefined;
}

function suiteFailure(reason) {
  return { ok: false, reason: `${reason}. Run \`picc update\` or reinstall PiCC.` };
}

export function validatePiSuite({ packageRoot = findPackageRoot() } = {}) {
  let root;
  try { root = canonicalPath(packageRoot); } catch { return suiteFailure("The PiCC package root is unavailable"); }
  const manifest = readJson(path.join(root, "package.json"));
  if (!manifest) return suiteFailure("PiCC package metadata is unreadable");
  const declarations = new Map();
  for (const name of PI_SUITE_PACKAGES) {
    const declared = parseStableExactVersion(manifest.dependencies?.[name]);
    if (!declared) return suiteFailure(`${name} must be declared at one stable exact version`);
    declarations.set(name, declared);
  }
  if (new Set(declarations.values()).size !== 1) {
    return suiteFailure(`Pi package declarations disagree (${[...declarations].map(([name, version]) => `${name}=${version}`).join(", ")})`);
  }
  const roots = admissibleNodeModules(root);
  const resolved = {};
  for (const name of PI_SUITE_PACKAGES) {
    const expected = declarations.get(name);
    const installed = resolveSuitePackage(name, roots);
    if (!installed) return suiteFailure(`${name} is missing (expected ${expected})`);
    if (installed.problem) return suiteFailure(`${name} ${installed.problem} (expected ${expected})`);
    if (installed.manifest.name !== name) return suiteFailure(`${name} has invalid package metadata`);
    if (installed.manifest.version !== expected) return suiteFailure(`${name} is ${installed.manifest.version ?? "unknown"}; expected ${expected}`);
    resolved[name] = installed.packageRoot;
  }
  return { ok: true, version: [...declarations.values()][0], resolved };
}

export function resolvePiCli(packageRoot = findPackageRoot()) {
  const suite = validatePiSuite({ packageRoot });
  if (!suite.ok) return suite;
  const codingRoot = suite.resolved["@earendil-works/pi-coding-agent"];
  try {
    const cli = canonicalPath(path.join(codingRoot, "dist", "cli.js"));
    if (!fs.statSync(cli).isFile() || !isPathInside(cli, codingRoot)) return suiteFailure("The embedded Pi CLI escaped its package root");
    return { ...suite, cli };
  } catch { return suiteFailure("The embedded Pi CLI is unavailable"); }
}

export function wireChildLifecycle(child, { onSpawnError, onExitCode, onSignal }) {
  let settled = false;
  child.once("error", () => {
    if (settled) return;
    settled = true;
    onSpawnError();
  });
  child.once("exit", (code, signal) => {
    if (settled) return;
    settled = true;
    if (signal) onSignal(signal);
    else onExitCode(code ?? 1);
  });
}

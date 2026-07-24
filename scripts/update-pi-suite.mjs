import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  PI_SUITE_PACKAGES,
  VALIDATION_MODES,
  canonicalPath,
  collectAdministrativeChild,
  compareStableVersions,
  discoverTrustedGit,
  discoverTrustedNpmCli,
  findPackageRoot,
  fixedNpmPolicyArgs,
  hardenedGitArgs,
  parseStableExactVersion,
  runTrustedGit,
  runTrustedNpm,
  validatePiSuite,
} from "../bin/picc-admin.mjs";

const HELP = "Usage: node scripts/update-pi-suite.mjs <exact-version>";
const RECOVERY_MODE = "--recover-ignored-state";
const SCRIPT_PATH = canonicalPath(fileURLToPath(import.meta.url));
const TRACKED_NAMES = Object.freeze(["package.json", "package-lock.json"]);

async function invokeChild(run, args, root, { captureStdout = false, deadlineMs, acceptedCodes } = {}) {
  try {
    const child = run(args, { cwd: root, trustedRoots: [root] });
    return await collectAdministrativeChild(child, { captureStdout, deadlineMs, acceptedCodes });
  } catch {
    return { ok: false, category: "spawn error", stdout: "" };
  }
}

function configuredFilterCommands(stdout) {
  const filters = new Map();
  for (const entry of stdout.split("\0")) {
    if (!entry) continue;
    const separator = entry.indexOf("\n");
    if (separator <= 0) return undefined;
    filters.set(entry.slice(0, separator).toLowerCase(), entry.slice(separator + 1));
  }
  return [...filters.values()].filter(Boolean);
}

async function probeTrackedCleanliness(root, runGit) {
  const filterResult = await invokeChild(runGit, hardenedGitArgs([
    "-C", root, "config", "--null", "--get-regexp", "^filter\\..*\\.(clean|process)$",
  ]), root, { captureStdout: true, acceptedCodes: [0, 1] });
  const filters = filterResult.ok ? configuredFilterCommands(filterResult.stdout) : undefined;
  if (!filters || filters.length > 0) return { ok: false, category: "Git filter policy could not be verified as non-executable" };

  const flags = await invokeChild(runGit, hardenedGitArgs([
    "-C", root, "ls-files", "-v", "--", ...TRACKED_NAMES,
  ]), root, { captureStdout: true });
  if (!flags.ok) return { ok: false, category: "Git tracked-file flags could not be verified" };
  const normal = new Set(flags.stdout.split(/\r?\n/).filter(Boolean));
  const abnormalNames = TRACKED_NAMES.filter((name) => !normal.has(`H ${name}`));
  if (abnormalNames.length > 0) {
    const command = `git update-index --no-skip-worktree --no-assume-unchanged -- ${abnormalNames.join(" ")}`;
    return {
      ok: false,
      names: abnormalNames,
      category: "must be normally tracked (skip-worktree and assume-unchanged are refused)",
      action: `From the PiCC checkout, run \`${command}\`, then retry.`,
    };
  }

  const status = await invokeChild(runGit, hardenedGitArgs([
    "-C", root, "status", "--porcelain=v2", "--untracked-files=all", "--", ...TRACKED_NAMES,
  ]), root, { captureStdout: true });
  if (!status.ok) return { ok: false, category: "Git cleanliness probe unavailable" };
  if (status.stdout.length === 0) return { ok: true };
  const dirtyNames = TRACKED_NAMES.filter((name) => status.stdout.split(/\r?\n/).some((line) => line.endsWith(` ${name}`) || line.endsWith(`\t${name}`)));
  const names = dirtyNames.length > 0 ? dirtyNames : TRACKED_NAMES;
  return { ok: false, names, category: `${names.length === 1 ? "has" : "have"} staged or unstaged changes` };
}

function regularIdentity(filename) {
  const stat = fs.lstatSync(filename, { bigint: true, throwIfNoEntry: false });
  if (!stat?.isFile() || stat.isSymbolicLink() || canonicalPath(filename) !== filename) return undefined;
  return `${stat.dev}:${stat.ino}`;
}

function readTrackedSnapshot(root) {
  const snapshot = { root, entries: [] };
  for (const name of TRACKED_NAMES) {
    const filename = path.join(root, name);
    const identity = regularIdentity(filename);
    if (!identity) return undefined;
    const bytes = fs.readFileSync(filename);
    if (regularIdentity(filename) !== identity) return undefined;
    snapshot.entries.push({ name, filename, identity, bytes });
  }
  try {
    const manifest = JSON.parse(snapshot.entries[0].bytes.toString("utf8"));
    const lock = JSON.parse(snapshot.entries[1].bytes.toString("utf8"));
    if (manifest?.name !== "picc" || !manifest.dependencies || lock?.lockfileVersion !== 3 || !lock.packages) return undefined;
  } catch {
    return undefined;
  }
  return snapshot;
}

function preMutationSnapshotUnchanged(snapshot) {
  try {
    if (canonicalPath(snapshot.root) !== snapshot.root) return false;
    return snapshot.entries.every(({ filename, identity, bytes }) => regularIdentity(filename) === identity && fs.readFileSync(filename).equals(bytes));
  } catch {
    return false;
  }
}

function rollbackSnapshotMatches(snapshot) {
  try {
    if (canonicalPath(snapshot.root) !== snapshot.root) return false;
    return snapshot.entries.every(({ filename, bytes }) => Boolean(regularIdentity(filename)) && fs.readFileSync(filename).equals(bytes));
  } catch {
    return false;
  }
}

function replaceRegularFile(snapshot, entry) {
  if (canonicalPath(snapshot.root) !== snapshot.root || canonicalPath(path.dirname(entry.filename)) !== snapshot.root) return false;
  const temporary = path.join(snapshot.root, `.${entry.name}.picc-rollback-${randomUUID()}`);
  let descriptor;
  try {
    descriptor = fs.openSync(temporary, "wx", 0o600);
    fs.writeFileSync(descriptor, entry.bytes);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporary, entry.filename);
    const stat = fs.lstatSync(entry.filename);
    return stat.isFile() && !stat.isSymbolicLink() && canonicalPath(entry.filename) === entry.filename;
  } catch {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    return false;
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function restoreSnapshot(snapshot) {
  return snapshot.entries.every((entry) => replaceRegularFile(snapshot, entry)) && rollbackSnapshotMatches(snapshot);
}

function shellQuote(value, platform) {
  if (/[\x00-\x1f\x7f]/.test(value)) throw new Error("unsafe recovery command value");
  return platform === "win32" ? `'${value.replaceAll("'", "''")}'` : `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function ignoredStateRecoveryCommand(platform = process.platform, {
  nodePath = process.execPath,
  scriptPath = SCRIPT_PATH,
} = {}) {
  const label = platform === "win32" ? "PowerShell recovery command" : "POSIX shell recovery command";
  const invocation = [nodePath, scriptPath, RECOVERY_MODE].map((value) => shellQuote(value, platform)).join(" ");
  return `${label} (run from the PiCC checkout): ${platform === "win32" ? `& ${invocation}` : invocation}`;
}

function recoveryGuidance(output) {
  output.error("PiCC: ignored dependency state could not be restored deterministically.");
  output.error(ignoredStateRecoveryCommand());
}

function dependenciesAvailable(options) {
  const npmCli = options.discoverNpm ? options.discoverNpm() : discoverTrustedNpmCli();
  const git = options.discoverGit ? options.discoverGit() : discoverTrustedGit();
  return Boolean(options.runNpm || npmCli) && Boolean(options.runGit || git);
}

async function recover(root, snapshot, dependencies, before, output, cause) {
  if (!restoreSnapshot(snapshot)) {
    output.error(`PiCC: ${cause}; exact tracked rollback failed. Restore package.json and package-lock.json from reviewable source control before continuing.`);
    return 1;
  }
  const restored = await invokeChild(dependencies.runNpm, ["ci", ...fixedNpmPolicyArgs()], root, { deadlineMs: dependencies.deadlineMs });
  if (!rollbackSnapshotMatches(snapshot) && !restoreSnapshot(snapshot)) {
    output.error(`PiCC: ${cause}; recovery changed tracked metadata and exact rollback failed. Restore both dependency metadata files from reviewable source control.`);
    return 1;
  }
  let graph = { ok: false };
  if (restored.ok && rollbackSnapshotMatches(snapshot)) {
    try {
      graph = dependencies.validateSuite({ packageRoot: root, mode: before.mode });
    } catch { /* recovery remains a fixed operational failure */ }
  }
  if (restored.ok && graph.ok && graph.version === before.version && rollbackSnapshotMatches(snapshot)) {
    output.error(`PiCC: ${cause}; tracked files and ignored dependency state were restored.`);
    return 1;
  }
  output.error(`PiCC: ${cause}; tracked files were restored exactly.`);
  recoveryGuidance(output);
  return 1;
}

async function prepare(options, output) {
  if (!dependenciesAvailable(options)) {
    output.error("PiCC: trusted npm and Git administration are required; install them from their official distributions and retry. No files were changed.");
    return undefined;
  }
  let root;
  try { root = canonicalPath(options.packageRoot ?? findPackageRoot(import.meta.url)); }
  catch { output.error("PiCC: package ownership could not be verified."); return undefined; }
  if (fs.lstatSync(path.join(root, ".npmrc"), { throwIfNoEntry: false })) {
    output.error("PiCC: update refused because the checkout contains a project .npmrc.");
    return undefined;
  }
  const dependencies = {
    runNpm: options.runNpm ?? runTrustedNpm,
    runGit: options.runGit ?? runTrustedGit,
    validateSuite: options.validateSuite ?? validatePiSuite,
    deadlineMs: options.deadlineMs,
  };
  const snapshot = readTrackedSnapshot(root);
  if (!snapshot) {
    output.error("PiCC: package.json and package-lock.json must be canonical regular npm v3 metadata files.");
    return undefined;
  }
  const cleanliness = await probeTrackedCleanliness(root, dependencies.runGit);
  if (!cleanliness.ok) {
    const names = cleanliness.names?.join(" and ");
    const action = cleanliness.action ?? (names ? `Commit or restore ${names}, then retry.` : "");
    output.error(`PiCC: update refused because ${names ? `${names} ${cleanliness.category}` : cleanliness.category}.${action ? ` ${action}` : ""} No registry or npm mutation was attempted.`);
    return undefined;
  }
  if (!preMutationSnapshotUnchanged(snapshot)) {
    output.error("PiCC: update refused because package.json or package-lock.json changed while Git state was being verified. Restore both files, then retry. No registry or npm mutation was attempted.");
    return undefined;
  }
  return { root, dependencies, snapshot };
}

export async function runPiSuiteRecovery(options = {}) {
  const output = options.output ?? console;
  const prepared = await prepare(options, output);
  if (!prepared) return 1;
  const result = await invokeChild(prepared.dependencies.runNpm, ["ci", ...fixedNpmPolicyArgs()], prepared.root, { deadlineMs: prepared.dependencies.deadlineMs });
  if (!rollbackSnapshotMatches(prepared.snapshot) && !restoreSnapshot(prepared.snapshot)) {
    output.error("PiCC: ignored dependency recovery changed tracked metadata and exact rollback failed. Restore both dependency metadata files from reviewable source control.");
    return 1;
  }
  if (!result.ok) {
    output.error(`PiCC: ignored dependency recovery failed (${result.category}); tracked metadata was restored exactly.`);
    return 1;
  }
  let after;
  try { after = prepared.dependencies.validateSuite({ packageRoot: prepared.root }); }
  catch { after = { ok: false }; }
  if (!after.ok || !rollbackSnapshotMatches(prepared.snapshot)) {
    output.error("PiCC: ignored dependency recovery completed, but the resulting full dependency graph is not coherent.");
    return 1;
  }
  output.log(`Outcome: restored ignored dependency state for embedded Pi ${after.version}.`);
  return 0;
}

export async function runPiSuiteUpdate(options = {}) {
  const output = options.output ?? console;
  const argv = options.argv ?? process.argv.slice(2);
  if (argv.length !== 1 || !parseStableExactVersion(argv[0])) {
    output.error(`PiCC: expected one stable exact version. ${HELP}`);
    return 1;
  }
  const target = argv[0];
  const prepared = await prepare(options, output);
  if (!prepared) return 1;
  const { root, dependencies, snapshot } = prepared;
  let before;
  try { before = dependencies.validateSuite({ packageRoot: root }); }
  catch { before = { ok: false }; }
  if (!before.ok) {
    output.error("PiCC: current dependency graph preflight failed. Restore or synchronize the reviewed checkout before choosing a newer Pi suite.");
    return 1;
  }
  if (compareStableVersions(target, before.version) <= 0) {
    output.error(`PiCC: target ${target} must be newer than the current complete direct Pi suite.`);
    return 1;
  }
  if (!preMutationSnapshotUnchanged(snapshot)) {
    output.error("PiCC: tracked dependency metadata changed before registry preflight; no registry or npm mutation was attempted.");
    return 1;
  }

  for (const name of PI_SUITE_PACKAGES) {
    const artifact = `${name}@${target}`;
    const result = await invokeChild(dependencies.runNpm, ["view", artifact, "version", "--json", ...fixedNpmPolicyArgs()], root, { captureStdout: true, deadlineMs: dependencies.deadlineMs });
    if (!preMutationSnapshotUnchanged(snapshot)) {
      if (!restoreSnapshot(snapshot)) output.error("PiCC: registry preflight changed tracked metadata and exact rollback failed. Restore both dependency metadata files from reviewable source control.");
      else output.error("PiCC: registry preflight unexpectedly changed tracked dependency metadata; the original bytes were restored.");
      return 1;
    }
    if (!result.ok) {
      output.error(`PiCC: public-registry preflight failed operationally (${result.category}); no update was started.`);
      return 1;
    }
    let exact = false;
    try { exact = JSON.parse(result.stdout) === target; } catch { exact = false; }
    if (!exact) {
      output.error(`PiCC: exact artifact mismatch for ${artifact}; no update was started.`);
      return 1;
    }
  }
  if (!preMutationSnapshotUnchanged(snapshot)) {
    output.error("PiCC: tracked dependency metadata changed during preflight; no update was started.");
    return 1;
  }

  const install = await invokeChild(dependencies.runNpm, [
    "install", ...PI_SUITE_PACKAGES.map((name) => `${name}@${target}`), "--save-exact", ...fixedNpmPolicyArgs(),
  ], root, { deadlineMs: dependencies.deadlineMs });
  if (!install.ok) return recover(root, snapshot, dependencies, before, output, `suite install failed (${install.category})`);

  let after;
  try { after = dependencies.validateSuite({ packageRoot: root, mode: VALIDATION_MODES.STRICT_EXACT }); }
  catch { return recover(root, snapshot, dependencies, before, output, "post-install full-graph validation threw"); }
  if (!after.ok || after.version !== target) return recover(root, snapshot, dependencies, before, output, "post-install exact graph validation failed");
  output.log(`Outcome: updated the complete direct Pi suite to ${target}. Review compatibility changes and run the complete verification suite.`);
  return 0;
}

const directEntry = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (directEntry) {
  process.exitCode = process.argv.length === 3 && process.argv[2] === RECOVERY_MODE
    ? await runPiSuiteRecovery()
    : await runPiSuiteUpdate();
}

export default runPiSuiteUpdate;

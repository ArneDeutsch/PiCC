import { randomUUID } from "node:crypto";
import fs from "node:fs";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { rootCertificates } from "node:tls";
import {
  VALIDATION_MODES,
  canonicalPath,
  collectAdministrativeChild,
  classifyInstallation,
  compareStableVersions,
  discoverGlobalNpmRoot,
  findPackageRoot,
  fixedNpmPolicyArgs,
  hardenedGitArgs,
  parseStableExactVersion,
  runTrustedGit,
  runTrustedNpm,
  validatePiSuite,
} from "./picc-admin.mjs";

const REGISTRY_URL = "https://registry.npmjs.org/picc/latest";
const REGISTRY_TIMEOUT_MS = 5_000;
const MAX_REGISTRY_BYTES = 64 * 1024;
const RETAINED_RECOVERY_POLICY = "The referenced npm policy files were created and retained for recovery.";
const HELP = `Usage: picc update [--check|--help]

Checks or synchronizes PiCC as one compatible product. It never updates embedded Pi independently.`;

function readManifest(root) {
  try {
    const value = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
    return value?.name === "picc" && parseStableExactVersion(value.version) ? value : undefined;
  } catch {
    return undefined;
  }
}

function reportIdentity(output, manifest, suite, provenance) {
  output.log(`PiCC ${manifest.version}`);
  output.log(`Embedded Pi ${suite.ok ? suite.version : "unavailable/incoherent"}`);
  output.log(`Install ${provenance}`);
}

export function requestLatestFromRegistry(requestGet = https.get, timers = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let request;
    let response;
    let responseEnded = false;
    let onResponseData;
    let onResponseEnd;
    const clear = timers.clearTimeout ?? clearTimeout;
    const schedule = timers.setTimeout ?? setTimeout;
    let deadline;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      if (deadline !== undefined) clear(deadline);
      request?.removeListener("error", onRequestError);
      request?.removeListener("close", onRequestClose);
      if (response) {
        response.removeListener("error", onResponseError);
        response.removeListener("aborted", onResponseAborted);
        response.removeListener("close", onResponseClose);
        if (onResponseData) response.removeListener("data", onResponseData);
        if (onResponseEnd) response.removeListener("end", onResponseEnd);
      }
      if (error) reject(error); else resolve(value);
    };
    const onRequestError = (error) => finish(error);
    const onRequestClose = () => finish(new Error("registry request closed prematurely"));
    const onResponseError = (error) => finish(error);
    const onResponseAborted = () => finish(new Error("registry response aborted"));
    const onResponseClose = () => {
      if (!responseEnded) finish(new Error("registry response closed prematurely"));
    };
    deadline = schedule(() => {
      request?.destroy();
      finish(new Error("registry deadline exceeded"));
    }, REGISTRY_TIMEOUT_MS);
    try {
      request = requestGet(REGISTRY_URL, {
        headers: { accept: "application/json", "user-agent": "picc-update" },
        rejectUnauthorized: true,
        ca: rootCertificates,
      }, (incoming) => {
        response = incoming;
        response.on("error", onResponseError);
        response.on("aborted", onResponseAborted);
        response.on("close", onResponseClose);
        if (response.statusCode !== 200) {
          response.resume();
          finish(new Error("registry status"));
          return;
        }
        let size = 0;
        const chunks = [];
        onResponseData = (chunk) => {
          size += chunk.length;
          if (size > MAX_REGISTRY_BYTES) {
            request.destroy();
            finish(new Error("registry body too large"));
            return;
          }
          chunks.push(chunk);
        };
        onResponseEnd = () => {
          responseEnded = true;
          if (settled) return;
          try {
            const metadata = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            const version = metadata && !Array.isArray(metadata) && metadata.name === "picc"
              ? parseStableExactVersion(metadata.version)
              : undefined;
            if (!version) throw new Error("registry schema");
            finish(undefined, version.raw);
          } catch (error) {
            finish(error);
          }
        };
        response.on("data", onResponseData);
        response.on("end", onResponseEnd);
      });
      request.once("error", onRequestError);
      request.once("close", onRequestClose);
    } catch (error) {
      finish(error);
    }
  });
}

function npmCodeScanner() {
  const prefixes = ["code ", "npm error code ", "npm ERR! code "];
  let positions = prefixes.map(() => 0);
  let capturing = false;
  let candidate = "";
  let found;
  const reset = () => {
    positions = prefixes.map(() => 0);
    capturing = false;
    candidate = "";
  };
  const endLine = () => {
    if (/^E[A-Z0-9_]{1,31}$/.test(candidate)) found ??= candidate;
    reset();
  };
  return {
    consume(chunk) {
      for (const character of String(chunk)) {
        if (character === "\r" || character === "\n") { endLine(); continue; }
        if (capturing) {
          if (candidate.length < 32 && /[A-Z0-9_]/.test(character)) candidate += character;
          else candidate = "!";
          continue;
        }
        for (let index = 0; index < prefixes.length; index += 1) {
          if (positions[index] < 0) continue;
          if (character !== prefixes[index][positions[index]]) { positions[index] = -1; continue; }
          positions[index] += 1;
          if (positions[index] === prefixes[index].length) capturing = true;
        }
      }
    },
    code() { endLine(); return found; },
  };
}

async function collectChild(child, { npmErrorCode = false } = {}) {
  const scanner = npmErrorCode ? npmCodeScanner() : undefined;
  const result = await collectAdministrativeChild(child, {
    deadlineMs: null,
    stderrConsumer: (chunk) => scanner?.consume(chunk),
  });
  if (!result.ok && result.category === "nonzero exit") {
    const code = scanner?.code();
    if (code) return { ...result, category: `npm ${code}` };
  }
  return result;
}

async function runGit(args, root, dependencies, acceptedCodes = [0]) {
  let child;
  let hardenedArgs;
  try {
    hardenedArgs = hardenedGitArgs(args);
    child = dependencies.runGit(hardenedArgs, { cwd: root, trustedRoots: [root] });
  } catch { return { ok: false, stdout: "" }; }
  return collectAdministrativeChild(child, { captureStdout: true, deadlineMs: null, acceptedCodes });
}

function configuredFilterCommands(stdout) {
  const filters = new Map();
  for (const entry of stdout.split("\0")) {
    if (!entry) continue;
    const separator = entry.indexOf("\n");
    if (separator <= 0) return undefined;
    filters.set(entry.slice(0, separator).toLowerCase(), entry.slice(separator + 1));
  }
  return [...filters.values()].filter((value) => value.length > 0);
}

async function inspectSource(root, dependencies) {
  const top = await runGit(["-C", root, "rev-parse", "--show-toplevel"], root, dependencies);
  if (!top.ok) return { ok: false, reason: "PiCC: source ownership could not be verified." };
  try {
    if (canonicalPath(top.stdout.trim()) !== root) return { ok: false, reason: "PiCC: update refused because this is not the canonical PiCC checkout root." };
  } catch {
    return { ok: false, reason: "PiCC: source ownership could not be verified." };
  }
  const filterQuery = ["config", "--null", "--get-regexp", "^filter\\..*\\.(clean|process)$"];
  const [localFilters, effectiveFilters, worktreeConfig] = await Promise.all([
    runGit(["-C", root, ...filterQuery.slice(0, 1), "--local", ...filterQuery.slice(1)], root, dependencies, [0, 1]),
    runGit(["-C", root, ...filterQuery], root, dependencies, [0, 1]),
    runGit(["-C", root, "config", "--bool", "--get", "extensions.worktreeConfig"], root, dependencies, [0, 1]),
  ]);
  const filterResults = [localFilters, effectiveFilters];
  if (worktreeConfig.ok && worktreeConfig.code === 0 && worktreeConfig.stdout.trim() === "true") {
    filterResults.push(await runGit(["-C", root, ...filterQuery.slice(0, 1), "--worktree", ...filterQuery.slice(1)], root, dependencies, [0, 1]));
  } else if (!worktreeConfig.ok || (worktreeConfig.code === 0 && worktreeConfig.stdout.trim() !== "false")) {
    return { ok: false, reason: "PiCC: source Git filter policy could not be verified." };
  }
  if (filterResults.some((result) => !result.ok)) return { ok: false, reason: "PiCC: source Git filter policy could not be verified." };
  const filterCommands = filterResults.map((result) => configuredFilterCommands(result.stdout));
  if (filterCommands.some((commands) => commands === undefined)) return { ok: false, reason: "PiCC: source Git filter policy could not be verified." };
  if (filterCommands.some((commands) => commands.length > 0)) return { ok: false, reason: "PiCC: update refused because the source checkout config defines an executable clean or process filter." };
  const status = await runGit(["-C", root, "status", "--porcelain=v2", "--untracked-files=all"], root, dependencies);
  if (!status.ok) return { ok: false, reason: "PiCC: source state could not be verified." };
  if (status.stdout.length > 0) return { ok: false, reason: "PiCC: update refused because the source checkout has staged, unstaged, unmerged, or untracked changes." };
  const gitDirResult = await runGit(["-C", root, "rev-parse", "--absolute-git-dir"], root, dependencies);
  if (!gitDirResult.ok) return { ok: false, reason: "PiCC: source operation state could not be verified." };
  let gitDir;
  try { gitDir = canonicalPath(gitDirResult.stdout.trim()); } catch { return { ok: false, reason: "PiCC: source operation state could not be verified." }; }
  const operationMarkers = ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "BISECT_LOG", "rebase-apply", "rebase-merge"];
  if (operationMarkers.some((name) => fs.existsSync(path.join(gitDir, name)))) {
    return { ok: false, reason: "PiCC: update refused while a Git merge, rebase, cherry-pick, revert, or bisect is in progress." };
  }
  const branch = await runGit(["-C", root, "symbolic-ref", "-q", "HEAD"], root, dependencies);
  return { ok: true, detached: !branch.ok };
}

function npmPolicyArgs() {
  return fixedNpmPolicyArgs();
}

let recoveryConfigDirectory;

export function recoveryNpmPolicyArgs(platform = process.platform) {
  if (platform !== process.platform) throw new Error("recovery policy must target the current platform");
  if (!recoveryConfigDirectory) {
    const tempRoot = platform === "win32"
      ? path.join(os.userInfo().homedir, "AppData", "Local", "Temp")
      : "/tmp";
    recoveryConfigDirectory = fs.mkdtempSync(path.join(tempRoot, `picc-recovery-${randomUUID()}-`), { encoding: "utf8" });
    fs.chmodSync(recoveryConfigDirectory, 0o700);
    for (const name of ["user.npmrc", "global.npmrc"]) {
      const descriptor = fs.openSync(path.join(recoveryConfigDirectory, name), "wx", 0o600);
      fs.closeSync(descriptor);
    }
  }
  return fixedNpmPolicyArgs({
    userConfig: path.join(recoveryConfigDirectory, "user.npmrc"),
    globalConfig: path.join(recoveryConfigDirectory, "global.npmrc"),
  });
}

export function cleanupRecoveryNpmPolicy() {
  if (!recoveryConfigDirectory) return false;
  fs.rmSync(recoveryConfigDirectory, { recursive: true, force: true });
  recoveryConfigDirectory = undefined;
  return true;
}

function globalPrefix(globalRoot) {
  const parent = path.dirname(globalRoot);
  const prefix = path.basename(parent) === "lib" ? path.dirname(parent) : parent;
  const expected = process.platform === "win32" ? path.join(prefix, "node_modules") : path.join(prefix, "lib", "node_modules");
  try {
    const canonical = canonicalPath(prefix);
    return !/[\x00-\x1f\x7f]/.test(canonical) && canonicalPath(expected) === globalRoot ? canonical : undefined;
  } catch { return undefined; }
}

function shellQuote(value, platform = process.platform) {
  if (/[\x00-\x1f\x7f]/.test(value)) throw new Error("unsafe recovery argument");
  return platform === "win32" ? `'${value.replaceAll("'", "''")}'` : `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function reinstallGuidance(version, prefix, platform = process.platform, policy) {
  if (!parseStableExactVersion(version) || /[\x00-\x1f\x7f]/.test(prefix)) throw new Error("unsafe recovery input");
  const createdPolicy = policy === undefined;
  const recoveryPolicy = policy ?? recoveryNpmPolicyArgs(platform);
  const args = ["install", "--global", `picc@${version}`, `--prefix=${prefix}`, ...recoveryPolicy];
  const label = platform === "win32" ? "PowerShell recovery command" : "POSIX shell recovery command";
  const command = `${label}: npm ${args.map((value) => shellQuote(value, platform)).join(" ")}`;
  return createdPolicy ? `${RETAINED_RECOVERY_POLICY}\n${command}` : command;
}

function childFailure(stage, result) {
  return `PiCC: ${stage} failed (${result.category ?? "spawn error"}).`;
}

function sourceNpmGuidance(args, next, platform = process.platform) {
  const label = platform === "win32" ? "PowerShell diagnostic command" : "POSIX shell diagnostic command";
  return `${RETAINED_RECOVERY_POLICY}\n${label} (run from the PiCC checkout): npm ${args.map((value) => shellQuote(value, platform)).join(" ")}\nAfter that command succeeds, run \`${next}\`.`;
}

async function handleGlobal({ action, root, globalRoot, manifest, suite, output, dependencies }) {
  reportIdentity(output, manifest, suite, "verified public-registry global npm");
  let latest;
  try { latest = await dependencies.requestLatest(); } catch {
    output.error("PiCC: update check failed at the fixed public registry endpoint; retry when registry connectivity is available.");
    return 1;
  }
  const prefix = globalPrefix(globalRoot);
  if (!prefix) {
    output.error("PiCC: update refused because the verified global npm prefix is ambiguous.");
    return 1;
  }
  const compared = compareStableVersions(latest, manifest.version);
  const recovery = () => reinstallGuidance(compared > 0 ? latest : manifest.version, prefix);
  if (!suite.ok && (action === "check" || compared <= 0)) {
    output.error("Outcome: the installed PiCC package has an incoherent embedded Pi suite and is not up to date.");
    output.error(recovery());
    return 1;
  }
  if (compared <= 0) {
    output.log(`Outcome: PiCC is up to date (${manifest.version}).`);
    return 0;
  }
  if (action === "check") {
    output.log(`Outcome: PiCC ${latest} is available. Run \`picc update\` to install it.`);
    return 0;
  }
  const args = ["install", "--global", `picc@${latest}`, `--prefix=${prefix}`, ...npmPolicyArgs()];
  let result;
  try { result = await collectChild(dependencies.runNpm(args)); } catch { result = { ok: false, category: "spawn error" }; }
  if (!result.ok) {
    output.error(`${childFailure("global update", result)} The global install may now be incomplete.`);
    output.error(recovery());
    return 1;
  }
  const nextManifest = readManifest(root);
  const nextSuite = dependencies.validateSuite({ packageRoot: root, mode: VALIDATION_MODES.STRICT_EXACT });
  const nextOrigin = dependencies.classify({ packageRoot: root, globalRoot });
  if (nextManifest?.version !== latest) {
    output.error("PiCC: npm completed, but the installed PiCC version did not match the requested exact version.");
    output.error(recovery());
    return 1;
  }
  if (nextOrigin !== "verified public-registry global npm") {
    output.error("PiCC: npm completed, but public-registry provenance could not be reverified.");
    output.error(recovery());
    return 1;
  }
  if (!nextSuite.ok) {
    output.error("PiCC: npm completed, but the embedded Pi suite remained incomplete or inconsistent.");
    output.error(recovery());
    return 1;
  }
  output.log(`Outcome: updated the complete PiCC product to ${latest} (embedded Pi ${nextSuite.version}).`);
  return 0;
}

async function handleSource({ action, root, manifest, suite, output, dependencies }) {
  reportIdentity(output, manifest, suite, "source");
  const state = await inspectSource(root, dependencies);
  if (!state.ok) { output.error(state.reason); return 1; }
  if (action === "check") {
    if (!suite.ok) {
      output.error("Outcome: source dependency state is not coherent. Run `picc update` from this checkout to rebuild ignored dependencies.");
      return 1;
    }
    output.log(`Outcome: source manifest, lockfile, and installed dependencies are coherent${state.detached ? " (detached HEAD; check only)" : ""}.`);
    return 0;
  }
  if (state.detached) {
    output.error("PiCC: source synchronization refused on detached HEAD. Check out the intended branch and run `picc update` again.");
    return 1;
  }
  if (fs.lstatSync(path.join(root, ".npmrc"), { throwIfNoEntry: false })) {
    output.error("PiCC: source synchronization refused because this checkout contains a project .npmrc; remove it from the intended revision before running `picc update`.");
    return 1;
  }
  const policy = npmPolicyArgs();
  let preflight;
  try { preflight = await collectChild(dependencies.runNpm(["ci", "--dry-run", ...policy], { cwd: root, trustedRoots: [root] }), { npmErrorCode: true }); }
  catch { preflight = { ok: false, category: "spawn error" }; }
  if (!preflight.ok) {
    output.error(`${childFailure("source manifest/lockfile preflight", preflight)} No dependency rebuild was started.`);
    output.error(sourceNpmGuidance(["ci", "--dry-run", ...recoveryNpmPolicyArgs()], "picc update"));
    return 1;
  }
  output.log("PiCC: rebuilding ignored dependency state for the currently checked-out revision; tracked source will not be updated.");
  let result;
  try { result = await collectChild(dependencies.runNpm(["ci", ...policy], { cwd: root, trustedRoots: [root] }), { npmErrorCode: true }); }
  catch { result = { ok: false, category: "spawn error" }; }
  if (!result.ok) {
    output.error(`${childFailure("source dependency synchronization", result)} Ignored dependency state may have changed.`);
    output.error(sourceNpmGuidance(["ci", ...recoveryNpmPolicyArgs()], "picc update --check"));
    return 1;
  }
  const afterState = await inspectSource(root, dependencies);
  if (!afterState.ok) {
    output.error(afterState.reason);
    output.error("PiCC: dependency synchronization completed, but source state revalidation failed. Inspect and correct the checkout state, then run `picc update --check`.");
    return 1;
  }
  const afterSuite = dependencies.validateSuite({ packageRoot: root });
  if (!afterSuite.ok) {
    output.error("PiCC: dependency synchronization completed, but the installed Pi suite is still incomplete or inconsistent; ignored dependency state may be partial.");
    output.error(sourceNpmGuidance(["ci", ...recoveryNpmPolicyArgs()], "picc update --check"));
    return 1;
  }
  output.log(`Outcome: synchronized ignored dependencies for this revision (embedded Pi ${afterSuite.version}); no newer source revision was adopted.`);
  return 0;
}

export async function runUpdate(options = {}) {
  const action = options.action ?? "update";
  const output = options.output ?? console;
  if (action === "help") { output.log(HELP); return 0; }
  if (action !== "check" && action !== "update") { output.error("PiCC: invalid update action."); return 1; }
  const dependencies = {
    requestLatest: options.requestLatest ?? requestLatestFromRegistry,
    runNpm: options.runNpm ?? runTrustedNpm,
    runGit: options.runGit ?? runTrustedGit,
    validateSuite: options.validateSuite ?? validatePiSuite,
    classify: options.classify ?? classifyInstallation,
  };
  let root;
  try { root = canonicalPath(options.packageRoot ?? findPackageRoot(import.meta.url)); } catch { output.error("PiCC: package ownership could not be verified."); return 1; }
  const manifest = readManifest(root);
  if (!manifest) { output.error("PiCC: package metadata is malformed."); return 1; }
  const suite = dependencies.validateSuite({ packageRoot: root });
  const localOrigin = dependencies.classify({ packageRoot: root });
  const globalRoot = options.globalRoot === undefined ? discoverGlobalNpmRoot() : options.globalRoot;
  let provenance = localOrigin;
  if (localOrigin !== "source" && globalRoot) {
    try { provenance = dependencies.classify({ packageRoot: root, globalRoot: canonicalPath(globalRoot) }); } catch { provenance = "unknown/other"; }
  }
  if (provenance === "verified public-registry global npm") {
    return handleGlobal({ action, root, globalRoot: canonicalPath(globalRoot), manifest, suite, output, dependencies });
  }
  if (provenance === "source") return handleSource({ action, root, manifest, suite, output, dependencies });
  reportIdentity(output, manifest, suite, provenance);
  if (provenance === "known local package") {
    output.error(`Outcome: PiCC will not mutate an owning project. Run \`npm install picc@${manifest.version}\` in that project, or choose and install a newer exact PiCC version there.`);
  } else {
    output.error("Outcome: PiCC installation ownership could not be identified. Reinstall through the package manager or wrapper that installed it; no files were changed.");
  }
  return 1;
}

export default runUpdate;

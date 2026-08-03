#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  canonicalPath,
  classifyInstallation,
  compareStableVersions,
  discoverGlobalNpmRoot,
  discoverNpmCommand,
  discoverTrustedGit,
  findPackageRoot,
  isPathInside,
  parseStableExactVersion,
  resolvePiCli,
} from "./picc-admin.mjs";
import { verifyCompiledRuntime } from "./picc-runtime.mjs";

const HELP = `Usage: picc update [--check|--help]

Source checkouts rebuild dependencies for the checked-out revision.
Global npm installs update through npm. Other installed copies are owned by
their package manager and are never modified by PiCC.`;
const NPM_FLAGS = Object.freeze(["--ignore-scripts", "--no-audit", "--no-fund"]);
const CHILD_OUTPUT_LIMIT = 64 * 1024;
const PI_UPDATE_SUFFIX = "Run `picc update` or reinstall PiCC.";
const SOURCE_BUILD_COMMAND = "npm run build";
const SOURCE_NPM_COMMAND = "npm ci --ignore-scripts --no-audit --no-fund";

function readManifest(root) {
  try {
    const value = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
    return value?.name === "@arnedeutsch/picc" && parseStableExactVersion(value.version) ? value : undefined;
  } catch { return undefined; }
}

function appendBounded(current, chunk) {
  const combined = Buffer.concat([current, Buffer.from(chunk)]);
  return combined.length <= CHILD_OUTPUT_LIMIT ? combined : combined.subarray(-CHILD_OUTPUT_LIMIT);
}

function boundedDetail(value) {
  return Buffer.from(value).subarray(0, CHILD_OUTPUT_LIMIT).toString("utf8").trim();
}

async function defaultBuildRuntime(options) {
  const { buildRuntime } = await import("../scripts/build-runtime.mjs");
  return buildRuntime(options);
}

function collect(child) {
  return new Promise((resolve) => {
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    const resultOutput = () => ({ stdout: stdout.toString("utf8"), stderr: stderr.toString("utf8") });
    child.stdout?.on("data", (chunk) => { stdout = appendBounded(stdout, chunk); });
    child.stderr?.on("data", (chunk) => { stderr = appendBounded(stderr, chunk); });
    child.once("error", (error) => resolve({ ok: false, code: null, ...resultOutput(), error }));
    child.once("close", (code, signal) => resolve({ ok: code === 0 && signal === null, code, signal, ...resultOutput() }));
  });
}

function defaultGit(args, { cwd }) {
  const git = discoverTrustedGit();
  if (!git) {
    throw new Error(process.env.PICC_GIT !== undefined
      ? "PICC_GIT does not identify a trusted Git executable; correct or unset the override"
      : "Git was not found on PATH; install Git or set PICC_GIT to its absolute path");
  }
  return spawn(git, args, { cwd, env: process.env, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
}

function defaultNpm(args, { cwd }) {
  const npm = discoverNpmCommand();
  if (!npm) throw new Error("npm was not found; install npm and retry");
  return spawn(npm.command, [...npm.args, ...args], {
    cwd, env: process.env, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
  });
}

async function runChild(start, args, root) {
  try { return await collect(start(args, { cwd: root })); }
  catch (error) { return { ok: false, code: null, stdout: "", stderr: "", error }; }
}

function childReason(label, result) {
  const detail = result.stderr?.trim() || boundedDetail(result.error?.message ?? "");
  return `PiCC: ${label} failed${detail ? `: ${detail}` : "."}`;
}

async function inspectSource(root, runGit) {
  const status = await runChild(runGit, ["-C", root, "status", "--porcelain"], root);
  if (!status.ok) return { ok: false, dirty: false, reason: childReason("Git status", status) };
  if (status.stdout.length > 0) {
    return {
      ok: false,
      dirty: true,
      reason: `PiCC: update refused because the source checkout has staged, unstaged, unmerged, or untracked changes. Keep intentional edits and run \`${SOURCE_BUILD_COMMAND}\` from the PiCC checkout root to refresh the compiled runtime.`,
    };
  }
  return { ok: true, dirty: false };
}

function runtimeReason(result) {
  return result.ok ? "" : result.reason;
}

function updaterPiReason(result) {
  if (result.ok) return "";
  const reason = result.reason.trimEnd();
  return reason.endsWith(PI_UPDATE_SUFFIX)
    ? reason.slice(0, -PI_UPDATE_SUFFIX.length).trimEnd()
    : reason;
}

async function inspectSourceProduct({ root, validateRuntime, validateSuite }) {
  const runtime = await validateRuntime({ packageRoot: root, checkSource: true });
  const suite = await validateSuite({ packageRoot: root });
  return { runtime, suite };
}

function reportSourceCheck({ source, product, output }) {
  let failed = false;
  let productFailed = false;
  if (!source.ok) {
    output.error(source.reason);
    failed = true;
  }
  if (!product.runtime.ok) {
    output.error(`Outcome: the source checkout runtime needs rebuilding. ${runtimeReason(product.runtime)}`);
    failed = true;
    productFailed = true;
  }
  if (!product.suite.ok) {
    output.error(`Outcome: source dependencies are not coherent. ${updaterPiReason(product.suite)}`);
    failed = true;
    productFailed = true;
  }
  if (productFailed) {
    if (!product.runtime.ok && !product.suite.ok) {
      output.error(`After correcting the reported problems, run \`${SOURCE_NPM_COMMAND}\` from the PiCC checkout root, then run \`${SOURCE_BUILD_COMMAND}\` from the PiCC checkout root, then run \`picc update --check\`.`);
    } else if (!product.runtime.ok) {
      output.error(`After correcting the reported runtime problem, run \`${SOURCE_BUILD_COMMAND}\` from the PiCC checkout root, then run \`picc update --check\`.`);
    } else {
      output.error(`After correcting the reported dependency problem, run \`${SOURCE_NPM_COMMAND}\` from the PiCC checkout root, then run \`picc update --check\`.`);
    }
  }
  if (failed) return 1;
  output.log(`Outcome: source checkout is clean with a verified runtime and coherent dependencies (embedded Pi ${product.suite.version}).`);
  return 0;
}

async function handleSource({ action, root, output, runGit, runNpm, buildRuntime, validateRuntime, validateSuite }) {
  const source = await inspectSource(root, runGit);
  if (action === "check") {
    if (!source.ok && !source.dirty) { output.error(source.reason); return 1; }
    const product = await inspectSourceProduct({ root, validateRuntime, validateSuite });
    return reportSourceCheck({ source, product, output });
  }
  if (!source.ok) { output.error(source.reason); return 1; }

  output.log("PiCC: rebuilding dependencies and the compiled runtime for the currently checked-out revision; tracked source will not be updated.");
  const installed = await runChild(runNpm, ["ci", ...NPM_FLAGS], root);
  if (!installed.ok) {
    output.error(childReason("npm ci", installed));
    output.error("Correct the reported npm error, then rerun `picc update` so dependency synchronization, runtime build, and product validation all follow.");
    return 1;
  }
  try {
    await buildRuntime({ packageRoot: root });
  } catch (error) {
    const detail = boundedDetail(error instanceof Error ? error.message : String(error));
    output.error(`PiCC: dependency synchronization completed but the compiled runtime build failed${detail ? `: ${detail}` : "."}`);
    output.error(`After correcting the reported build error, run \`${SOURCE_BUILD_COMMAND}\` from the PiCC checkout root, then run \`picc update --check\`.`);
    return 1;
  }
  const runtime = await validateRuntime({ packageRoot: root, checkSource: true });
  if (!runtime.ok) {
    output.error(`PiCC: the runtime build completed but product validation failed. ${runtimeReason(runtime)}`);
    output.error(`After correcting the reported runtime problem, run \`${SOURCE_BUILD_COMMAND}\` from the PiCC checkout root, then run \`picc update --check\`.`);
    return 1;
  }
  const suite = await validateSuite({ packageRoot: root });
  if (!suite.ok) {
    output.error(`PiCC: the runtime build completed but Pi validation failed. ${updaterPiReason(suite)}`);
    output.error(`After correcting the reported embedded Pi problem, run \`${SOURCE_NPM_COMMAND}\` from the PiCC checkout root, then run \`${SOURCE_BUILD_COMMAND}\` from the PiCC checkout root, then run \`picc update --check\`.`);
    return 1;
  }
  output.log(`Outcome: synchronized dependencies and verified the compiled runtime for this revision (embedded Pi ${suite.version}).`);
  return 0;
}

function parseNpmVersion(stdout) {
  const trimmed = stdout.trim();
  try {
    const parsed = JSON.parse(trimmed);
    return parseStableExactVersion(parsed);
  } catch {
    return parseStableExactVersion(trimmed);
  }
}

async function inspectInstalledProduct({ root, validateRuntime, validateSuite }) {
  const runtime = await validateRuntime({ packageRoot: root, checkSource: false });
  const suite = await validateSuite({ packageRoot: root });
  return { runtime, suite };
}

function installedFailure(product) {
  const reasons = [];
  if (!product.runtime.ok) reasons.push(product.runtime.reason);
  if (!product.suite.ok) reasons.push(updaterPiReason(product.suite));
  return reasons.join(" ");
}

async function handleGlobal({ action, root, globalRoot, manifest, output, runNpm, validateRuntime, validateSuite }) {
  const latestResult = await runChild(runNpm, ["view", "@arnedeutsch/picc", "version", "--json"], root);
  if (!latestResult.ok) {
    output.error(childReason("npm version check", latestResult));
    return 1;
  }
  const latest = parseNpmVersion(latestResult.stdout);
  if (!latest) { output.error("PiCC: npm returned an invalid latest version."); return 1; }
  const compared = compareStableVersions(latest, manifest.version);
  const product = await inspectInstalledProduct({ root, validateRuntime, validateSuite });
  if (action === "check") {
    if (!product.runtime.ok || !product.suite.ok) {
      output.error(`Outcome: the installed PiCC package needs repair. ${installedFailure(product)}`);
      output.error("Run `picc update`, then run `picc update --check` to verify the repaired global npm product.");
      return 1;
    }
    output.log(compared > 0
      ? `Outcome: PiCC ${latest} is available. Run \`picc update\` to install it.`
      : `Outcome: PiCC is up to date (${manifest.version}) with a verified runtime.`);
    return 0;
  }
  if (compared <= 0 && product.runtime.ok && product.suite.ok) {
    output.log(`Outcome: PiCC is up to date (${manifest.version}) with a verified runtime.`);
    return 0;
  }

  const forceReplacement = !product.runtime.ok || !product.suite.ok;
  const installArgs = ["install", "--global", ...(forceReplacement ? ["--force"] : []), "@arnedeutsch/picc@latest", ...NPM_FLAGS];
  const installed = await runChild(runNpm, installArgs, globalRoot);
  if (!installed.ok) {
    output.error(childReason(forceReplacement ? "global npm repair" : "global npm update", installed));
    output.error(`Retry \`npm install --global${forceReplacement ? " --force" : ""} @arnedeutsch/picc@latest --ignore-scripts --no-audit --no-fund\` after correcting the npm error.`);
    return 1;
  }

  const nextManifest = readManifest(root);
  const nextProduct = await inspectInstalledProduct({ root, validateRuntime, validateSuite });
  if (!nextManifest || nextManifest.version !== latest || !nextProduct.runtime.ok || !nextProduct.suite.ok) {
    const detail = !nextManifest || nextManifest.version !== latest
      ? `Expected PiCC ${latest}; found ${nextManifest?.version ?? "unknown"}.`
      : installedFailure(nextProduct);
    output.error(`PiCC: npm completed but the installed product did not validate. ${detail}`);
    output.error("Repair this global npm-owned copy with `npm install --global --force @arnedeutsch/picc@latest --ignore-scripts --no-audit --no-fund`, then run `picc update --check`.");
    return 1;
  }
  output.log(`${forceReplacement ? "Outcome: repaired" : "Outcome: updated"} PiCC ${latest} with a verified runtime (embedded Pi ${nextProduct.suite.version}).`);
  return 0;
}

export async function runUpdate(options = {}) {
  const action = options.action ?? "update";
  const output = options.output ?? console;
  if (action === "help") { output.log(HELP); return 0; }
  if (!["check", "update"].includes(action)) { output.error("PiCC: invalid update action."); return 1; }
  let root;
  try { root = canonicalPath(options.packageRoot ?? findPackageRoot(import.meta.url)); }
  catch { output.error("PiCC: package root is unavailable."); return 1; }
  const manifest = readManifest(root);
  if (!manifest) { output.error("PiCC: package metadata is malformed."); return 1; }
  const classify = options.classify ?? classifyInstallation;
  const runGit = options.runGit ?? defaultGit;
  const runNpm = options.runNpm ?? defaultNpm;
  const validateRuntime = options.validateRuntime ?? verifyCompiledRuntime;
  const validateSuite = options.validateSuite ?? (({ packageRoot }) => resolvePiCli(packageRoot));
  if (classify({ packageRoot: root }) === "source") {
    const buildRuntime = options.buildRuntime ?? defaultBuildRuntime;
    return handleSource({ action, root, output, runGit, runNpm, buildRuntime, validateRuntime, validateSuite });
  }
  const discoveredGlobalRoot = options.globalRoot === undefined ? discoverGlobalNpmRoot() : options.globalRoot;
  let globalRoot;
  let globalPackage;
  try {
    globalRoot = discoveredGlobalRoot ? canonicalPath(discoveredGlobalRoot) : undefined;
    const candidate = globalRoot ? path.join(globalRoot, "@arnedeutsch", "picc") : undefined;
    globalPackage = candidate && fs.statSync(candidate).isDirectory() ? canonicalPath(candidate) : undefined;
    if (globalPackage && !isPathInside(globalPackage, globalRoot)) globalPackage = undefined;
  } catch {
    globalRoot = undefined;
    globalPackage = undefined;
  }
  if (globalRoot && globalPackage === root) {
    return handleGlobal({ action, root, globalRoot, manifest, output, runNpm, validateRuntime, validateSuite });
  }
  output.error("Outcome: this installed PiCC copy is owned by another package manager or project and was not modified. Update it through that owner; for the documented global npm install run `npm install --global @arnedeutsch/picc@latest`.");
  return 1;
}

const directEntry = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (directEntry) process.exitCode = await runUpdate({ action: process.argv[2] === "--check" ? "check" : process.argv[2] === "--help" ? "help" : "update" });

export default runUpdate;

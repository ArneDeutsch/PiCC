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
  parseStableExactVersion,
  resolvePiCli,
} from "./picc-admin.mjs";

const HELP = `Usage: picc update [--check|--help]

Source checkouts rebuild dependencies for the checked-out revision.
Global npm installs update through npm. Other installed copies are owned by
their package manager and are never modified by PiCC.`;
const NPM_FLAGS = Object.freeze(["--ignore-scripts", "--no-audit", "--no-fund"]);

function readManifest(root) {
  try {
    const value = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
    return value?.name === "picc" && parseStableExactVersion(value.version) ? value : undefined;
  } catch { return undefined; }
}

function collect(child) {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => { stdout += Buffer.from(chunk).toString("utf8"); });
    child.stderr?.on("data", (chunk) => { stderr += Buffer.from(chunk).toString("utf8"); });
    child.once("error", (error) => resolve({ ok: false, code: null, stdout, stderr, error }));
    child.once("close", (code, signal) => resolve({ ok: code === 0 && signal === null, code, signal, stdout, stderr }));
  });
}

function defaultGit(args, { cwd }) {
  const git = discoverTrustedGit();
  if (!git) throw new Error("Git was not found on PATH; install Git or set PICC_GIT to its absolute path");
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
  const detail = result.stderr?.trim();
  return `PiCC: ${label} failed${detail ? `: ${detail}` : "."}`;
}

async function inspectSource(root, runGit) {
  const status = await runChild(runGit, ["-C", root, "status", "--porcelain"], root);
  if (!status.ok) return { ok: false, reason: childReason("Git status", status) };
  if (status.stdout.length > 0) {
    return { ok: false, reason: "PiCC: update refused because the source checkout has staged, unstaged, unmerged, or untracked changes." };
  }
  return { ok: true };
}

async function handleSource({ action, root, manifest, output, runGit, runNpm, validateSuite }) {
  const source = await inspectSource(root, runGit);
  if (!source.ok) { output.error(source.reason); return 1; }
  if (action === "check") {
    const suite = validateSuite({ packageRoot: root });
    if (!suite.ok) {
      output.error(`Outcome: source dependencies are not coherent. ${suite.reason}`);
      return 1;
    }
    output.log(`Outcome: source checkout is clean and dependencies are coherent (embedded Pi ${suite.version}).`);
    return 0;
  }
  output.log("PiCC: rebuilding dependencies for the currently checked-out revision; tracked source will not be updated.");
  const installed = await runChild(runNpm, ["ci", ...NPM_FLAGS], root);
  if (!installed.ok) {
    output.error(childReason("npm ci", installed));
    output.error("Run `npm ci --ignore-scripts --no-audit --no-fund` in the PiCC checkout after correcting the npm error.");
    return 1;
  }
  const after = validateSuite({ packageRoot: root });
  if (!after.ok) {
    output.error(`PiCC: npm ci completed but Pi validation failed. ${after.reason}`);
    return 1;
  }
  output.log(`Outcome: synchronized dependencies for this revision (embedded Pi ${after.version}).`);
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

async function handleGlobal({ action, root, manifest, output, runNpm, validateSuite }) {
  const latestResult = await runChild(runNpm, ["view", "picc", "version", "--json"], root);
  if (!latestResult.ok) {
    output.error(childReason("npm version check", latestResult));
    return 1;
  }
  const latest = parseNpmVersion(latestResult.stdout);
  if (!latest) { output.error("PiCC: npm returned an invalid latest version."); return 1; }
  const compared = compareStableVersions(latest, manifest.version);
  const suite = validateSuite({ packageRoot: root });
  if (action === "check") {
    if (!suite.ok) { output.error(`Outcome: the installed PiCC package needs repair. ${suite.reason}`); return 1; }
    output.log(compared > 0
      ? `Outcome: PiCC ${latest} is available. Run \`picc update\` to install it.`
      : `Outcome: PiCC is up to date (${manifest.version}).`);
    return 0;
  }
  if (compared <= 0 && suite.ok) {
    output.log(`Outcome: PiCC is up to date (${manifest.version}).`);
    return 0;
  }
  const installed = await runChild(runNpm, ["install", "--global", "picc@latest", ...NPM_FLAGS], root);
  if (!installed.ok) {
    output.error(childReason("global npm update", installed));
    output.error("Retry `npm install --global picc@latest --ignore-scripts --no-audit --no-fund` after correcting the npm error.");
    return 1;
  }
  const nextManifest = readManifest(root);
  const nextSuite = validateSuite({ packageRoot: root });
  if (!nextManifest || nextManifest.version !== latest || !nextSuite.ok) {
    output.error(`PiCC: npm completed but the installed product did not validate. ${nextSuite.ok ? `Expected PiCC ${latest}; found ${nextManifest?.version ?? "unknown"}.` : nextSuite.reason}`);
    return 1;
  }
  output.log(`Outcome: updated PiCC to ${latest} (embedded Pi ${nextSuite.version}).`);
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
  const validateSuite = options.validateSuite ?? (({ packageRoot }) => resolvePiCli(packageRoot));
  if (classify({ packageRoot: root }) === "source") {
    return handleSource({ action, root, manifest, output, runGit, runNpm, validateSuite });
  }
  const globalRoot = options.globalRoot === undefined ? discoverGlobalNpmRoot() : options.globalRoot;
  let globalPackage;
  try { globalPackage = globalRoot ? canonicalPath(path.join(globalRoot, "picc")) : undefined; }
  catch { globalPackage = undefined; }
  if (globalPackage === root) return handleGlobal({ action, root, manifest, output, runNpm, validateSuite });
  output.error("Outcome: this installed PiCC copy is owned by another package manager or project and was not modified. Update it through that owner; for the documented global npm install run `npm install --global picc@latest`.");
  return 1;
}

const directEntry = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (directEntry) process.exitCode = await runUpdate({ action: process.argv[2] === "--check" ? "check" : process.argv[2] === "--help" ? "help" : "update" });

export default runUpdate;

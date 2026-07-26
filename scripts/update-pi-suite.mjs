#!/usr/bin/env node

import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  PI_SUITE_PACKAGES,
  canonicalPath,
  discoverNpmCommand,
  discoverTrustedGit,
  findPackageRoot,
  parseStableExactVersion,
  validatePiSuite,
} from "../bin/picc-admin.mjs";

const USAGE = "Usage: npm run update:pi -- <stable-exact-version>";
const METADATA = Object.freeze(["package.json", "package-lock.json"]);

function collect(child) {
  return new Promise((resolve) => {
    child.once("error", () => resolve(false));
    child.once("close", (code, signal) => resolve(code === 0 && signal === null));
  });
}

function fail(output, message) {
  output.error(`PiCC: ${message}`);
  return 1;
}

export async function runPiSuiteUpdate(options = {}) {
  const output = options.output ?? console;
  const argv = options.argv ?? process.argv.slice(2);
  if (argv.length !== 1 || !parseStableExactVersion(argv[0])) return fail(output, USAGE);
  let root;
  try { root = canonicalPath(options.packageRoot ?? findPackageRoot(import.meta.url)); }
  catch { return fail(output, "package root is unavailable."); }
  const git = options.discoverGit ? options.discoverGit() : discoverTrustedGit();
  const npm = options.discoverNpm ? options.discoverNpm() : discoverNpmCommand();
  if (!git || !npm) return fail(output, "Git and npm are required.");
  const run = options.spawnProcess ?? spawn;
  for (const args of [
    ["diff", "--quiet", "--", ...METADATA],
    ["diff", "--cached", "--quiet", "--", ...METADATA],
  ]) {
    if (!await collect(run(git, args, { cwd: root, env: process.env, stdio: "inherit", shell: false }))) {
      return fail(output, "package.json or package-lock.json is dirty; update refused.");
    }
  }
  const target = argv[0];
  const args = [
    ...npm.args, "install",
    ...PI_SUITE_PACKAGES.map((name) => `${name}@${target}`),
    "--save-exact", "--ignore-scripts", "--no-audit", "--no-fund",
  ];
  if (!await collect(run(npm.command, args, { cwd: root, env: process.env, stdio: "inherit", shell: false }))) {
    return fail(output, "npm install failed; inspect or restore package.json and package-lock.json.");
  }
  const suite = (options.validateSuite ?? validatePiSuite)({ packageRoot: root });
  if (!suite?.ok || suite.version !== target) return fail(output, suite?.reason ?? "Pi suite validation failed.");
  output.log(`Outcome: updated the complete direct Pi suite to ${target}.`);
  return 0;
}

const directEntry = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (directEntry) process.exitCode = await runPiSuiteUpdate();

export default runPiSuiteUpdate;

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  PI_SUITE_PACKAGES,
  VALIDATION_MODES,
  discoverTrustedGit,
  discoverTrustedNpmCli,
  findPackageRoot,
  parseStableExactVersion,
  validatePiSuite,
} from "../bin/picc-admin.mjs";

const USAGE = "Usage: node scripts/update-pi-suite.mjs <exact-version>";
const METADATA = Object.freeze(["package.json", "package-lock.json"]);
const RECOVERY = [
  "Inspect changes with: git diff -- package.json package-lock.json",
  "Restore package.json and package-lock.json with Git if needed.",
  "Then run: npm ci --ignore-scripts",
].join("\n");

function waitForChild(child) {
  return new Promise((resolve) => {
    child.once("error", () => resolve({ ok: false }));
    child.once("close", (code, signal) => resolve({ ok: code === 0 && signal === null, code, signal }));
  });
}

function fail(output, message) {
  output.error(`PiCC: ${message}\n${RECOVERY}`);
  return 1;
}

export async function runPiSuiteUpdate(options = {}) {
  const output = options.output ?? console;
  const argv = options.argv ?? process.argv.slice(2);
  if (argv.length !== 1 || !parseStableExactVersion(argv[0])) {
    output.error(`PiCC: expected one stable exact version. ${USAGE}`);
    return 1;
  }

  let root;
  try {
    root = fs.realpathSync(path.resolve(options.packageRoot ?? findPackageRoot(import.meta.url)));
  } catch {
    return fail(output, "package root is unavailable.");
  }

  const git = options.discoverGit ? options.discoverGit() : discoverTrustedGit();
  const npmCli = options.discoverNpm ? options.discoverNpm() : discoverTrustedNpmCli();
  if (!git || !npmCli) return fail(output, "Git and npm are required.");

  const run = options.spawnProcess ?? spawn;
  for (const args of [
    ["diff", "--quiet", "--", ...METADATA],
    ["diff", "--cached", "--quiet", "--", ...METADATA],
  ]) {
    let status;
    try {
      status = await waitForChild(run(git, args, { cwd: root, stdio: "inherit" }));
    } catch {
      return fail(output, "could not inspect dependency metadata with Git.");
    }
    if (!status.ok) {
      if (status.code === 1 && status.signal === null) {
        return fail(output, "package.json or package-lock.json has staged or unstaged changes; update refused.");
      }
      return fail(output, "could not inspect dependency metadata with Git.");
    }
  }

  const target = argv[0];
  const npmArgs = [
    npmCli,
    "install",
    ...PI_SUITE_PACKAGES.map((name) => `${name}@${target}`),
    "--save-exact",
    "--ignore-scripts",
  ];
  let installed;
  try {
    installed = await waitForChild(run(process.execPath, npmArgs, { cwd: root, stdio: "inherit" }));
  } catch {
    return fail(output, "npm install could not be started.");
  }
  if (!installed.ok) return fail(output, "npm install failed.");

  let graph;
  try {
    graph = (options.validateSuite ?? validatePiSuite)({
      packageRoot: root,
      mode: VALIDATION_MODES.STRICT_EXACT,
    });
  } catch {
    return fail(output, "strict Pi-suite validation failed.");
  }
  if (!graph?.ok || graph.version !== target) return fail(output, "strict Pi-suite validation failed.");

  output.log(`Outcome: updated the complete direct Pi suite to ${target}.`);
  return 0;
}

const directEntry = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (directEntry) process.exitCode = await runPiSuiteUpdate();

export default runPiSuiteUpdate;

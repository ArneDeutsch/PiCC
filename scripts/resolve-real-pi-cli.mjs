import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const REAL_PI_PACKAGE = "@earendil-works/pi-coding-agent";
export const REAL_PI_CLI_RELATIVE_PATH = path.join(
  "node_modules",
  "@earendil-works",
  "pi-coding-agent",
  "dist",
  "cli.js",
);
export const REAL_PI_MISSING_TEST_ENV = "PICC_REAL_PI_CLI_TEST_MISSING";

const DEFAULT_REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function isRegularFile(filePath) {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

export function resolveRealPiCli(options = {}) {
  const env = options.env ?? process.env;
  const repoRoot = options.repoRoot ?? DEFAULT_REPO_ROOT;
  const cliPath = path.join(repoRoot, REAL_PI_CLI_RELATIVE_PATH);
  const forcedMissing = env[REAL_PI_MISSING_TEST_ENV] === "1";
  return { cliPath, missing: forcedMissing || !isRegularFile(cliPath) };
}

export function missingRealPiMessage(cliPath) {
  return [
    `Required real-Pi CLI is missing: ${cliPath}`,
    `Run \`npm install\` in the PiCC checkout to install ${REAL_PI_PACKAGE} at the version supported by package.json, then retry.`,
  ].join("\n");
}

#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import {
  administrativeEnvironment,
  canonicalPath,
  cleanupAdministrativeEnvironment,
  collectAdministrativeChild,
  findPackageRoot,
  fixedNpmPolicyArgs,
  isPathInside,
  runTrustedNpm,
} from "../bin/picc-admin.mjs";

const USAGE = "Usage: node scripts/pack-release.mjs --output-dir <canonical-out-of-tree-directory>";
const PACK_DEADLINE_MS = 120_000;

function parseCli(argv) {
  if (argv.length !== 2 || argv[0] !== "--output-dir") throw new Error(USAGE);
  return { outputDir: argv[1] };
}

function canonicalEmptyDirectory(outputDir, packageRoot) {
  const resolvedInput = path.resolve(outputDir);
  const comparable = process.platform === "win32" ? resolvedInput.toLowerCase() : resolvedInput;
  const canonical = canonicalPath(resolvedInput);
  const stat = fs.lstatSync(resolvedInput, { throwIfNoEntry: false });
  if (!stat?.isDirectory() || stat.isSymbolicLink() || canonical !== comparable) throw new Error("Pack output directory must be a canonical regular directory");
  if (isPathInside(canonical, packageRoot) || isPathInside(packageRoot, canonical)) throw new Error("Pack output directory must be outside the project tree");
  if (fs.readdirSync(canonical).length !== 0) throw new Error("Pack output directory must be empty");
  return canonical;
}

/** @param {any} [options] @returns {Promise<any>} */
export async function packRelease({
  outputDir,
  packageRoot = findPackageRoot(import.meta.url),
  runNpm = runTrustedNpm,
  collect = collectAdministrativeChild,
} = {}) {
  const root = canonicalPath(packageRoot);
  const destination = canonicalEmptyDirectory(outputDir, root);
  let allocated = false;
  try {
    const environment = administrativeEnvironment();
    allocated = true;
    fs.writeFileSync(environment.npm_config_userconfig, "", { mode: 0o600 });
    fs.writeFileSync(environment.npm_config_globalconfig, "", { mode: 0o600 });
    const administrativeRoot = canonicalPath(path.dirname(environment.npm_config_userconfig));
    const args = [
      "pack", root, "--json", `--pack-destination=${destination}`,
      ...fixedNpmPolicyArgs({ userConfig: environment.npm_config_userconfig, globalConfig: environment.npm_config_globalconfig }),
    ];
    const child = runNpm(args, { cwd: administrativeRoot, trustedRoots: [administrativeRoot], stdio: "pipe" });
    const result = await collect(child, { captureStdout: true, deadlineMs: PACK_DEADLINE_MS });
    if (!result?.ok) throw new Error(`Sanitized npm pack failed: ${result?.category ?? "unknown error"}`);
    let parsed;
    try { parsed = JSON.parse(result.stdout); } catch { throw new Error("Sanitized npm pack returned malformed JSON"); }
    if (!Array.isArray(parsed) || parsed.length !== 1 || typeof parsed[0]?.filename !== "string" || path.basename(parsed[0].filename) !== parsed[0].filename || !parsed[0].filename.endsWith(".tgz")) {
      throw new Error("Sanitized npm pack did not return exactly one canonical tarball");
    }
    const tarball = canonicalPath(path.join(destination, parsed[0].filename));
    if (!isPathInside(tarball, destination) || !fs.statSync(tarball).isFile()) throw new Error("Sanitized npm pack output escaped its destination");
    const tgz = fs.readdirSync(destination).filter((entry) => entry.endsWith(".tgz"));
    if (tgz.length !== 1 || canonicalPath(path.join(destination, tgz[0])) !== tarball) throw new Error("Sanitized npm pack produced an ambiguous artifact set");
    return { tarball };
  } finally {
    if (allocated) cleanupAdministrativeEnvironment();
  }
}

export async function runPackReleaseCli(argv = process.argv.slice(2), output = console) {
  try {
    const result = await packRelease(parseCli(argv));
    output.log(JSON.stringify(result));
    return 0;
  } catch (error) {
    output.error(error instanceof Error ? error.message : "Sanitized npm pack failed");
    return 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) process.exitCode = await runPackReleaseCli();

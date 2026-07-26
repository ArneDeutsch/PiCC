#!/usr/bin/env node

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { canonicalPath, findPackageRoot, isPathInside, parseStableExactVersion, spawnNpm } from "../bin/picc-admin.mjs";

const USAGE = "Usage: node scripts/pack-release.mjs --output-dir <empty-out-of-tree-directory>";

function parseCli(argv) {
  if (argv.length !== 2 || argv[0] !== "--output-dir") throw new Error(USAGE);
  return { outputDir: argv[1] };
}

function collect(child) {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => { stdout += Buffer.from(chunk).toString("utf8"); });
    child.stderr?.on("data", (chunk) => { stderr += Buffer.from(chunk).toString("utf8"); });
    child.once("error", (error) => resolve({ ok: false, stdout, stderr, error }));
    child.once("close", (code, signal) => resolve({ ok: code === 0 && signal === null, stdout, stderr }));
  });
}

function emptyOutputDirectory(outputDir, packageRoot) {
  const resolved = path.resolve(outputDir);
  const canonical = canonicalPath(resolved);
  const stat = fs.lstatSync(resolved, { throwIfNoEntry: false });
  if (!stat?.isDirectory() || stat.isSymbolicLink()) throw new Error("Pack output must be a regular directory");
  if (isPathInside(canonical, packageRoot) || isPathInside(packageRoot, canonical)) throw new Error("Pack output must be outside the project tree");
  if (fs.readdirSync(canonical).length !== 0) throw new Error("Pack output directory must be empty");
  return canonical;
}

function sha256(filename) {
  return createHash("sha256").update(fs.readFileSync(filename)).digest("hex");
}

export async function packRelease({
  outputDir,
  packageRoot = findPackageRoot(import.meta.url),
  runNpm = spawnNpm,
} = {}) {
  const root = canonicalPath(packageRoot);
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  if (manifest?.name !== "picc" || !parseStableExactVersion(manifest.version)) throw new Error("Source package identity is invalid");
  const destination = emptyOutputDirectory(outputDir, root);
  const child = runNpm([
    "pack", root, "--json", "--ignore-scripts", `--pack-destination=${destination}`,
  ], { cwd: root, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
  const result = await collect(child);
  if (!result.ok) throw new Error(`npm pack failed${result.stderr.trim() ? `: ${result.stderr.trim()}` : ""}`);
  let records;
  try { records = JSON.parse(result.stdout); } catch { throw new Error("npm pack returned malformed JSON"); }
  const record = Array.isArray(records) && records.length === 1 ? records[0] : undefined;
  if (record?.name !== "picc" || record.version !== manifest.version ||
      typeof record.filename !== "string" || path.basename(record.filename) !== record.filename ||
      !record.filename.endsWith(".tgz")) {
    throw new Error("npm pack did not return one matching picc artifact");
  }
  const tarball = canonicalPath(path.join(destination, record.filename));
  if (!isPathInside(tarball, destination) || !fs.statSync(tarball).isFile()) throw new Error("npm pack artifact escaped its destination");
  if (fs.readdirSync(destination).filter((entry) => entry.endsWith(".tgz")).length !== 1) throw new Error("npm pack produced an ambiguous artifact set");
  return { name: "picc", version: manifest.version, tarball, sha256: sha256(tarball) };
}

export async function runPackReleaseCli(argv = process.argv.slice(2), output = console) {
  try {
    output.log(JSON.stringify(await packRelease(parseCli(argv))));
    return 0;
  } catch (error) {
    output.error(error instanceof Error ? error.message : "npm pack failed");
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await runPackReleaseCli();
}

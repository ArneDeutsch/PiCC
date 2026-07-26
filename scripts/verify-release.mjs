#!/usr/bin/env node

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  PI_SUITE_PACKAGES,
  canonicalPath,
  findPackageRoot,
  parseStableExactVersion,
  validatePiSuite,
} from "../bin/picc-admin.mjs";

const USAGE = "Usage: node scripts/verify-release.mjs <source|artifact> --event <tag|manual> [--tag vX.Y.Z] [--tarball path] [--expected-sha256 hex]";

function fail(message) { throw new Error(`Release verification failed: ${message}`); }

function readManifest(root) {
  try { return JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")); }
  catch { fail("source package manifest is invalid"); }
}

function verifySource(root, event, tag) {
  const manifest = readManifest(root);
  if (manifest?.name !== "picc" || !parseStableExactVersion(manifest.version)) fail("package name/version must be picc at a stable exact version");
  if (event === "tag" && tag !== `v${manifest.version}`) fail("tag must exactly match v<package version>");
  if (event === "manual" && tag !== undefined) fail("manual verification must not carry a tag");
  if (event !== "tag" && event !== "manual") fail("event must be tag or manual");
  const pins = PI_SUITE_PACKAGES.map((name) => manifest.dependencies?.[name]);
  if (pins.some((version) => !parseStableExactVersion(version)) || new Set(pins).size !== 1) fail("manifest must pin one exact Pi suite");
  const suite = validatePiSuite({ packageRoot: root });
  if (!suite.ok || suite.version !== pins[0]) fail(suite.reason ?? "installed Pi suite is invalid");
  return { manifest, version: manifest.version, suiteVersion: pins[0] };
}

function regularArtifact(tarball) {
  const resolved = path.resolve(tarball);
  const stat = fs.lstatSync(resolved, { throwIfNoEntry: false });
  if (!stat?.isFile() || stat.isSymbolicLink()) fail("tarball must be a regular file");
  const canonical = canonicalPath(resolved);
  const comparable = process.platform === "win32" ? resolved.toLowerCase() : resolved;
  if (canonical !== comparable) fail("tarball must be canonical");
  return canonical;
}

export function hashArtifact(tarball) {
  const filename = regularArtifact(tarball);
  const sha256 = createHash("sha256").update(fs.readFileSync(filename)).digest("hex");
  return { tarball: filename, sha256 };
}

export function verifyArtifactIdentity({ tarball, expectedSha256 } = {}) {
  if (typeof tarball !== "string") fail("artifact verification requires a tarball");
  const artifact = hashArtifact(tarball);
  if (expectedSha256 !== undefined &&
      (!/^[a-f0-9]{64}$/.test(expectedSha256) || artifact.sha256 !== expectedSha256)) {
    fail("tarball SHA-256 does not match");
  }
  return artifact;
}

export function verifyRelease({ mode, event, tag, tarball, expectedSha256, packageRoot } = {}) {
  let root;
  try { root = canonicalPath(packageRoot ?? findPackageRoot(import.meta.url)); }
  catch { fail("package root is unavailable"); }
  const source = verifySource(root, event, tag);
  if (mode === "source") {
    if (tarball !== undefined || expectedSha256 !== undefined) fail("source mode does not accept artifact arguments");
    return { ...source, packageRoot: root };
  }
  if (mode !== "artifact" || typeof tarball !== "string") fail("artifact mode requires a tarball");
  return { ...source, ...verifyArtifactIdentity({ tarball, expectedSha256 }), packageRoot: root };
}

function parseCli(argv) {
  const [mode, ...rest] = argv;
  const values = { mode };
  for (let index = 0; index < rest.length; index += 2) {
    const key = rest[index];
    const value = rest[index + 1];
    const property = { "--event": "event", "--tag": "tag", "--tarball": "tarball", "--expected-sha256": "expectedSha256" }[key];
    if (!property || value === undefined || values[property] !== undefined) fail(USAGE);
    values[property] = value;
  }
  return values;
}

export function runVerifyReleaseCli(argv = process.argv.slice(2), output = console) {
  try {
    const result = verifyRelease(parseCli(argv));
    output.log(JSON.stringify({ version: result.version, tarball: result.tarball, sha256: result.sha256 }));
    return 0;
  } catch (error) {
    output.error(error instanceof Error ? error.message : "Release verification failed");
    return 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = runVerifyReleaseCli();
}

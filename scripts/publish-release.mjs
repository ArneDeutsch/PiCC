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
  fixedNpmPolicyArgs,
  runAuthenticatedTrustedNpm,
} from "../bin/picc-admin.mjs";
import { verifyArtifactIdentity } from "./verify-release.mjs";

const USAGE = "Usage: node scripts/publish-release.mjs --tarball path --expected-sha256 hex --event <tag|manual> [--tag vX.Y.Z]";
const PUBLISH_DEADLINE_MS = 120_000;

function parseCli(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]; const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined) throw new Error(USAGE);
    const property = { "--event": "event", "--tag": "tag", "--tarball": "tarball", "--expected-sha256": "expectedSha256" }[key];
    if (!property || values[property] !== undefined) throw new Error(USAGE);
    values[property] = value;
  }
  return values;
}

function validateToken(token) {
  if (typeof token !== "string" || token.length === 0 || token.length > 4096 || !/^[!-~]+$/.test(token)) throw new Error("NPM_TOKEN is required and malformed tokens are refused");
}

function npmErrorCodeScanner() {
  const codes = ["EPUBLISHCONFLICT", "E403", "E401"];
  let tail = "";
  let detected;
  return {
    consume(chunk) {
      const text = `${tail}${Buffer.from(chunk).toString("utf8")}`;
      detected ??= codes.find((code) => text.includes(code));
      tail = text.slice(-(Math.max(...codes.map((code) => code.length)) - 1));
    },
    code() { return detected; },
  };
}

function publicationFailure(code) {
  const detail = code === "E401"
    ? "npm rejected authentication; replace or re-authorize NPM_TOKEN."
    : code === "E403"
      ? "npm refused publication; confirm the token can publish the picc package and satisfies npm policy."
      : code === "EPUBLISHCONFLICT"
        ? "npm reports this version already exists; confirm the registry version before retrying."
        : "npm publication failed; inspect the protected workflow logs and npm account state before retrying.";
  return `${detail} The GitHub Release may already exist; reconcile it before rerunning publication.`;
}

/** @param {any} [options] @returns {Promise<any>} */
export async function publishRelease({
  tarball,
  expectedSha256,
  event,
  tag,
  token = process.env.NPM_TOKEN,
  verify = verifyArtifactIdentity,
  runNpm = runAuthenticatedTrustedNpm,
  collect = collectAdministrativeChild,
  administration = administrativeEnvironment,
  cleanup = cleanupAdministrativeEnvironment,
  fileSystem = fs,
} = {}) {
  validateToken(token);
  const originalTarball = canonicalPath(tarball);
  const identity = { expectedSha256, event, tag };
  const preflight = verify({ tarball: originalTarball, ...identity });
  if (preflight?.tarball !== originalTarball || preflight.sha256 !== expectedSha256) throw new Error("artifact preflight did not return the expected canonical identity");
  let allocated = false;
  try {
    const environment = administration();
    allocated = true;
    const root = canonicalPath(path.dirname(environment.npm_config_userconfig));
    const privateDirectory = path.join(root, "verified-artifact");
    fileSystem.mkdirSync(privateDirectory, { mode: 0o700 });
    const privateTarball = path.join(privateDirectory, path.basename(originalTarball));
    fileSystem.copyFileSync(originalTarball, privateTarball, fs.constants.COPYFILE_EXCL);
    const canonicalPrivateTarball = canonicalPath(privateTarball);
    const copied = verify({ tarball: canonicalPrivateTarball, ...identity });
    if (copied?.tarball !== canonicalPrivateTarball || copied.sha256 !== preflight.sha256) throw new Error("private publication copy changed artifact identity");
    fileSystem.writeFileSync(environment.npm_config_userconfig, "//registry.npmjs.org/:_authToken=${NODE_AUTH_TOKEN}\n", { mode: 0o600 });
    fileSystem.writeFileSync(environment.npm_config_globalconfig, "", { mode: 0o600 });
    const args = [
      "publish", canonicalPrivateTarball, "--access=public",
      ...fixedNpmPolicyArgs({ userConfig: environment.npm_config_userconfig, globalConfig: environment.npm_config_globalconfig }),
    ];
    const scanner = npmErrorCodeScanner();
    let result;
    try {
      const child = runNpm(args, { token, cwd: root, trustedRoots: [root], stdio: "pipe" });
      result = await collect(child, { deadlineMs: PUBLISH_DEADLINE_MS, stderrConsumer: scanner.consume });
    } catch {
      throw new Error(publicationFailure(scanner.code()));
    }
    if (!result?.ok) throw new Error(publicationFailure(scanner.code()));
    return { tarball: originalTarball, sha256: preflight.sha256, version: preflight.version };
  } finally {
    if (allocated) cleanup();
  }
}

export async function runPublishReleaseCli(argv = process.argv.slice(2), output = console) {
  try {
    const result = await publishRelease(parseCli(argv));
    output.log(`Published picc ${result.version} from SHA-256 ${result.sha256}.`);
    return 0;
  } catch (error) {
    output.error(error instanceof Error ? error.message : "Release publication failed");
    return 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) process.exitCode = await runPublishReleaseCli();

#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { spawnNpm } from "../bin/picc-admin.mjs";
import { verifyRelease } from "./verify-release.mjs";

const USAGE = "Usage: node scripts/publish-release.mjs --tarball path --expected-sha256 hex --event tag --tag vX.Y.Z";

function parseCli(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    const property = { "--event": "event", "--tag": "tag", "--tarball": "tarball", "--expected-sha256": "expectedSha256" }[key];
    if (!property || value === undefined || values[property] !== undefined) throw new Error(USAGE);
    values[property] = value;
  }
  return values;
}

function validateToken(token) {
  if (typeof token !== "string" || token.length === 0 || token.length > 4096 || !/^[!-~]+$/.test(token)) {
    throw new Error("NPM_TOKEN is required and malformed tokens are refused");
  }
}

function collect(child) {
  return new Promise((resolve) => {
    let stderr = "";
    child.stderr?.on("data", (chunk) => { stderr += Buffer.from(chunk).toString("utf8"); });
    child.once("error", () => resolve({ ok: false, stderr }));
    child.once("close", (code, signal) => resolve({ ok: code === 0 && signal === null, stderr }));
  });
}

function publicationFailure(stderr) {
  if (stderr.includes("E401")) return "npm rejected authentication; replace or re-authorize NPM_TOKEN.";
  if (stderr.includes("E403")) return "npm refused publication; confirm the token can publish picc and satisfies npm policy.";
  if (stderr.includes("EPUBLISHCONFLICT")) return "npm reports this version already exists; compare its registry integrity with the retained release artifact before deciding whether publication completed.";
  return "npm publication failed; inspect the protected workflow log and retained release artifact before retrying.";
}

export async function publishRelease({
  tarball,
  expectedSha256,
  event,
  tag,
  token = process.env.NPM_TOKEN,
  packageRoot,
  runNpm = spawnNpm,
} = {}) {
  validateToken(token);
  const identity = verifyRelease({ mode: "artifact", event, tag, tarball, expectedSha256, packageRoot });
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "picc-publish-"));
  try {
    fs.writeFileSync(
      path.join(temp, ".npmrc"),
      "//registry.npmjs.org/:_authToken=${NODE_AUTH_TOKEN}\n",
      { encoding: "utf8", mode: 0o600, flag: "wx" },
    );
    const env = { ...process.env, NODE_AUTH_TOKEN: token };
    delete env.NPM_TOKEN;
    const child = runNpm([
      "publish", identity.tarball,
      "--registry=https://registry.npmjs.org/",
      "--access=public",
      "--ignore-scripts",
      "--provenance",
    ], { cwd: temp, env, stdio: ["ignore", "ignore", "pipe"] });
    const result = await collect(child);
    if (!result.ok) throw new Error(publicationFailure(result.stderr));
    return { tarball: identity.tarball, sha256: identity.sha256, version: identity.version };
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
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

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await runPublishReleaseCli();
}

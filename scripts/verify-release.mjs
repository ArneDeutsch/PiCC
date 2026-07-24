#!/usr/bin/env node

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { gunzipSync, inflateRawSync } from "node:zlib";
import { pathToFileURL } from "node:url";
import {
  PI_SUITE_PACKAGES,
  VALIDATION_MODES,
  canonicalPath,
  findPackageRoot,
  parseStableExactVersion,
  validatePiSuite,
} from "../bin/picc-admin.mjs";

const USAGE = "Usage: node scripts/verify-release.mjs <source|artifact|identity> --event <tag|manual> [--tag vX.Y.Z] [--tarball path] [--expected-sha256 hex]";
const MAX_COMPRESSED_BYTES = 32 * 1024 * 1024;
const MAX_ARCHIVE_BYTES = 128 * 1024 * 1024;
const BLOCK = 512;
const utf8 = new TextDecoder("utf-8", { fatal: true });

function fail(message) { throw new Error(`Release preflight failed: ${message}`); }

function regularCanonicalFile(filename, label) {
  let canonical;
  try { canonical = canonicalPath(filename); } catch { fail(`${label} is unavailable`); }
  const stat = fs.lstatSync(filename, { throwIfNoEntry: false });
  const resolved = path.resolve(filename);
  const comparable = process.platform === "win32" ? resolved.toLowerCase() : resolved;
  if (!stat?.isFile() || stat.isSymbolicLink() || canonical !== comparable) fail(`${label} must be a canonical regular file`);
  return canonical;
}

function readJson(filename, label) {
  try { return JSON.parse(fs.readFileSync(filename, "utf8")); }
  catch { fail(`${label} is invalid JSON`); }
}

function checkEvent(manifest, event, tag) {
  if (manifest?.name !== "picc" || !parseStableExactVersion(manifest.version)) fail("package name/version must be picc at a stable exact version");
  if (event === "tag") {
    if (tag !== `v${manifest.version}`) fail("tag must exactly match v<package version>");
  } else if (event === "manual") {
    if (tag !== undefined) fail("manual releases must not carry a tag");
  } else fail("event must be tag or manual");
}

function releaseIdentity(root, event, tag, validateSuite = validatePiSuite) {
  const manifestPath = regularCanonicalFile(path.join(root, "package.json"), "source package manifest");
  const manifest = readJson(manifestPath, "source package manifest");
  checkEvent(manifest, event, tag);
  const suite = validateSuite({ packageRoot: root, mode: VALIDATION_MODES.STRICT_EXACT });
  if (!suite?.ok) fail(suite?.reason ?? "strict installed Pi graph validation failed");
  return { manifest, version: manifest.version, suiteVersion: suite.version };
}

function decode(bytes, label) {
  try { return utf8.decode(bytes); } catch { fail(`tar archive has malformed ${label}`); }
}

function fieldString(block, start, length, label) {
  const bytes = block.subarray(start, start + length);
  const nul = bytes.indexOf(0);
  const content = nul < 0 ? bytes : bytes.subarray(0, nul);
  if (nul >= 0 && !bytes.subarray(nul).every((byte) => byte === 0)) fail(`tar archive has malformed ${label}`);
  const value = decode(content, label);
  if (/[\x00-\x1f\x7f]/u.test(value)) fail(`tar archive has control characters in ${label}`);
  return value;
}

function tarNumber(block, start, length, label) {
  const bytes = block.subarray(start, start + length);
  if ((bytes[0] & 0x80) !== 0) fail(`tar archive has malformed ${label}`);
  const raw = bytes.toString("ascii");
  if (!/^[0-7]+ \0$/.test(raw)) fail(`tar archive has malformed ${label}`);
  const digits = raw.match(/^[0-7]+/)?.[0];
  const value = Number.parseInt(digits, 8);
  if (!Number.isSafeInteger(value)) fail(`tar archive has malformed ${label}`);
  return value;
}

function parsePax(bytes) {
  const values = new Map();
  let offset = 0;
  while (offset < bytes.length) {
    const space = bytes.indexOf(0x20, offset);
    if (space < 0) fail("tar archive has malformed PAX metadata");
    const lengthText = bytes.subarray(offset, space).toString("ascii");
    if (!/^[1-9]\d*$/.test(lengthText)) fail("tar archive has malformed PAX metadata");
    const length = Number(lengthText);
    const end = offset + length;
    if (!Number.isSafeInteger(length) || end > bytes.length || end <= space + 2 || bytes[end - 1] !== 0x0a) fail("tar archive has malformed PAX metadata");
    const record = decode(bytes.subarray(space + 1, end - 1), "PAX metadata");
    const equals = record.indexOf("=");
    if (equals <= 0) fail("tar archive has malformed PAX metadata");
    const key = record.slice(0, equals);
    const value = record.slice(equals + 1);
    if (key !== "path" || values.has(key)) fail("tar archive has unsupported PAX metadata");
    values.set(key, value);
    offset = end;
  }
  return values;
}

function gzipHeaderEnd(compressed) {
  if (compressed.length < 18 || compressed[0] !== 0x1f || compressed[1] !== 0x8b || compressed[2] !== 8) fail("release tarball is not a bounded gzip archive");
  const flags = compressed[3];
  if ((flags & 0xe0) !== 0) fail("release tarball has malformed gzip metadata");
  let offset = 10;
  const terminated = () => {
    const end = compressed.indexOf(0, offset);
    if (end < 0) fail("release tarball has malformed gzip metadata");
    offset = end + 1;
  };
  if (flags & 4) {
    if (offset + 2 > compressed.length) fail("release tarball has malformed gzip metadata");
    const length = compressed.readUInt16LE(offset); offset += 2 + length;
    if (offset > compressed.length) fail("release tarball has malformed gzip metadata");
  }
  if (flags & 8) terminated();
  if (flags & 16) terminated();
  if (flags & 2) offset += 2;
  if (offset + 8 > compressed.length) fail("release tarball has malformed gzip metadata");
  return offset;
}

function boundedSingleGunzip(compressed) {
  const start = gzipHeaderEnd(compressed);
  let info;
  try { info = inflateRawSync(compressed.subarray(start), { maxOutputLength: MAX_ARCHIVE_BYTES, info: true }); }
  catch { fail("release tarball is not a bounded gzip archive"); }
  const consumed = info.engine.bytesWritten;
  if (!Number.isSafeInteger(consumed) || start + consumed + 8 !== compressed.length) fail("release tarball contains concatenated or trailing compressed data");
  let verified;
  try { verified = gunzipSync(compressed, { maxOutputLength: MAX_ARCHIVE_BYTES }); }
  catch { fail("release tarball is not a bounded gzip archive"); }
  if (!Buffer.from(info.buffer).equals(verified)) fail("release tarball gzip integrity is invalid");
  return verified;
}

function validateMemberPath(name) {
  if (!name || name.startsWith("/") || name.startsWith("//") || /^[A-Za-z]:/.test(name) || name.includes("\\") || /[\x00-\x1f\x7f]/u.test(name)) fail("tar archive contains an unsafe member path");
  const parts = name.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..") || parts[0] !== "package") fail("tar archive contains an unsafe member path");
}

export function inspectTarball(tarball) {
  const filename = regularCanonicalFile(path.resolve(tarball), "release tarball");
  const compressed = fs.readFileSync(filename);
  if (compressed.length === 0 || compressed.length > MAX_COMPRESSED_BYTES) fail("release tarball has an invalid compressed size");
  const sha256 = createHash("sha256").update(compressed).digest("hex");
  const archive = boundedSingleGunzip(compressed);
  const members = new Map();
  let offset = 0;
  let pax;
  let terminated = false;
  while (offset + BLOCK <= archive.length) {
    const header = archive.subarray(offset, offset + BLOCK);
    if (header.every((byte) => byte === 0)) {
      if (offset + 2 * BLOCK > archive.length || !archive.subarray(offset + BLOCK, offset + 2 * BLOCK).every((byte) => byte === 0)) fail("tar archive requires two zero terminator blocks");
      if (!archive.subarray(offset + 2 * BLOCK).every((byte) => byte === 0)) fail("tar archive contains post-terminator data");
      terminated = true;
      break;
    }
    const checksumRaw = header.subarray(148, 156).toString("ascii");
    if (!/^[0-7]{6} \0$/.test(checksumRaw)) fail("tar archive has malformed checksum metadata");
    const expected = Number.parseInt(checksumRaw.slice(0, 6), 8);
    let actual = 0;
    for (let index = 0; index < BLOCK; index += 1) actual += index >= 148 && index < 156 ? 0x20 : header[index];
    if (actual !== expected) fail("tar archive checksum is invalid");
    const size = tarNumber(header, 124, 12, "size metadata");
    const typeByte = header[156];
    const type = typeByte === 0 ? "0" : String.fromCharCode(typeByte);
    const magic = header.subarray(257, 263);
    if (!magic.equals(Buffer.from([0x75, 0x73, 0x74, 0x61, 0x72, 0])) || header.subarray(263, 265).toString("ascii") !== "00") fail("tar archive has unsupported header dialect");
    const prefix = fieldString(header, 345, 155, "path prefix");
    const baseName = fieldString(header, 0, 100, "member path");
    const linkName = fieldString(header, 157, 100, "link metadata");
    if (linkName) fail("tar archive contains unsupported link metadata");
    const headerName = prefix ? `${prefix}/${baseName}` : baseName;
    const dataStart = offset + BLOCK;
    const paddedSize = Math.ceil(size / BLOCK) * BLOCK;
    const dataEnd = dataStart + size;
    const next = dataStart + paddedSize;
    if (!Number.isSafeInteger(next) || next > archive.length) fail("tar archive is truncated");
    if (!archive.subarray(dataEnd, next).every((byte) => byte === 0)) fail("tar archive has nonzero member padding");
    const data = archive.subarray(dataStart, dataEnd);
    if (type === "x") {
      if (pax) fail("tar archive has dangling extension metadata");
      pax = parsePax(data);
    } else {
      if (type !== "0" && type !== "5") fail("tar archive contains an unsupported member type");
      const name = pax?.get("path") ?? headerName;
      pax = undefined;
      validateMemberPath(name);
      if (name.split("/").slice(1).includes("node_modules")) fail("tar archive contains a forbidden node_modules subtree");
      if (type === "5" && size !== 0) fail("tar directory member contains data");
      if (members.has(name)) fail(`tar archive contains duplicate member ${name}`);
      members.set(name, { type, data: Buffer.from(data) });
    }
    offset = next;
  }
  if (!terminated) fail("tar archive is truncated or lacks two zero terminator blocks");
  if (pax) fail("tar archive has dangling extension metadata");
  return { filename, sha256, members };
}

function walkRequired(root, relative, output) {
  const absolute = path.join(root, relative);
  const stat = fs.lstatSync(absolute, { throwIfNoEntry: false });
  if (!stat || stat.isSymbolicLink()) fail(`required source path ${relative} is unavailable or linked`);
  if (stat.isFile()) { output.set(`package/${relative.replaceAll(path.sep, "/")}`, absolute); return; }
  if (!stat.isDirectory()) fail(`required source path ${relative} is not a regular file or directory`);
  for (const entry of fs.readdirSync(absolute).sort()) walkRequired(root, path.join(relative, entry), output);
}

function requiredMembers(root, manifest) {
  const required = new Map();
  for (const relative of ["src", "bin", "picc"]) walkRequired(root, relative, required);
  for (const target of Object.values(manifest.bin ?? {})) {
    if (typeof target !== "string" || target.includes("\\") || path.posix.isAbsolute(target) || target.split("/").some((part) => part === "..")) fail("package bin targets must be safe relative strings");
    const relative = target.replace(/^\.\//, "");
    walkRequired(root, relative, required);
  }
  return required;
}

function packedManifest(inspected) {
  const member = inspected.members.get("package/package.json");
  if (!member || member.type !== "0") fail("packed package manifest is missing or not a regular file");
  try { return JSON.parse(utf8.decode(member.data)); }
  catch { fail("packed package manifest is invalid JSON"); }
}

function bindArchiveToSource(inspected, root) {
  for (const [memberName, member] of inspected.members) {
    const relative = memberName === "package" ? "" : memberName.slice("package/".length);
    const source = relative ? path.join(root, ...relative.split("/")) : root;
    const stat = fs.lstatSync(source, { throwIfNoEntry: false });
    if (!stat || stat.isSymbolicLink()) fail(`tar member has no canonical source counterpart: ${memberName}`);
    let canonical;
    try { canonical = canonicalPath(source); } catch { fail(`tar member has no canonical source counterpart: ${memberName}`); }
    const resolved = path.resolve(source);
    const comparable = process.platform === "win32" ? resolved.toLowerCase() : resolved;
    if (canonical !== comparable) fail(`tar member has no canonical source counterpart: ${memberName}`);
    if (member.type === "0") {
      if (!stat.isFile()) fail(`regular tar member does not match a source regular file: ${memberName}`);
      if (!member.data.equals(fs.readFileSync(canonical))) fail(`regular tar member differs from source: ${memberName}`);
    } else if (!stat.isDirectory()) {
      fail(`directory tar member does not match a source directory: ${memberName}`);
    }
  }
}

/** @param {any} [options] @returns {any} */
export function verifyArtifactIdentity({ tarball, expectedSha256, event, tag } = {}) {
  if (typeof tarball !== "string" || !/^[a-f0-9]{64}$/.test(expectedSha256 ?? "")) fail("artifact identity requires a tarball and lowercase SHA-256");
  const inspected = inspectTarball(tarball);
  if (inspected.sha256 !== expectedSha256) fail("release tarball SHA-256 does not match the inspected artifact");
  const manifest = packedManifest(inspected);
  checkEvent(manifest, event, tag);
  const versions = PI_SUITE_PACKAGES.map((name) => manifest.dependencies?.[name]);
  if (versions.some((version) => !parseStableExactVersion(version)) || new Set(versions).size !== 1) fail("packed manifest does not contain one exact Pi suite");
  return { tarball: inspected.filename, sha256: inspected.sha256, manifest, version: manifest.version, suiteVersion: versions[0] };
}

/** @param {any} [options] @returns {any} */
export function verifyRelease({ mode, event, tag, tarball, expectedSha256, packageRoot, validateSuite } = {}) {
  let root;
  try { root = canonicalPath(packageRoot ?? findPackageRoot(import.meta.url)); }
  catch { fail("package root is unavailable"); }
  const identity = releaseIdentity(root, event, tag, validateSuite);
  if (mode === "source") {
    if (tarball !== undefined || expectedSha256 !== undefined) fail("source mode does not accept artifact arguments");
    return { ...identity, packageRoot: root };
  }
  if (mode !== "artifact" || typeof tarball !== "string") fail("artifact mode requires one tarball");
  const inspected = inspectTarball(tarball);
  if (expectedSha256 !== undefined && inspected.sha256 !== expectedSha256) fail("release tarball SHA-256 does not match the inspected artifact");
  const manifest = packedManifest(inspected);
  if (JSON.stringify(manifest) !== JSON.stringify(identity.manifest)) fail("packed package manifest does not exactly match the inspected source manifest");
  bindArchiveToSource(inspected, root);
  for (const [member, source] of requiredMembers(root, identity.manifest)) {
    const entry = inspected.members.get(member);
    if (!entry || entry.type !== "0") fail(`required regular tar member is missing: ${member}`);
    if (!entry.data.equals(fs.readFileSync(source))) fail(`required regular tar member differs from source: ${member}`);
  }
  for (const name of PI_SUITE_PACKAGES) if (manifest.dependencies?.[name] !== identity.suiteVersion) fail(`packed manifest does not pin ${name} to the inspected Pi suite`);
  return { ...identity, packageRoot: root, tarball: inspected.filename, sha256: inspected.sha256 };
}

function parseCli(argv) {
  const [mode, ...rest] = argv;
  const values = { mode };
  for (let index = 0; index < rest.length; index += 2) {
    const key = rest[index]; const value = rest[index + 1];
    if (!key?.startsWith("--") || value === undefined) fail(USAGE);
    const property = { "--event": "event", "--tag": "tag", "--tarball": "tarball", "--expected-sha256": "expectedSha256" }[key];
    if (!property || values[property] !== undefined) fail(USAGE);
    values[property] = value;
  }
  return values;
}

export function runVerifyReleaseCli(argv = process.argv.slice(2), output = console) {
  try {
    const options = parseCli(argv);
    const result = options.mode === "identity" ? verifyArtifactIdentity(options) : verifyRelease(options);
    output.log(JSON.stringify({ version: result.version, tarball: result.tarball, sha256: result.sha256 }));
    return 0;
  } catch (error) {
    output.error(error instanceof Error ? error.message : "Release preflight failed");
    return 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) process.exitCode = runVerifyReleaseCli();

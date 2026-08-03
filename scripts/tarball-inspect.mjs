import { inflateRawSync } from "node:zlib";

const DEFAULT_LIMITS = Object.freeze({
  compressedBytes: 32 * 1024 * 1024,
  expandedBytes: 128 * 1024 * 1024,
  memberBytes: 16 * 1024 * 1024,
  totalFileBytes: 96 * 1024 * 1024,
  entries: 8192,
  gzipMetadataBytes: 4096,
});
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/u;
const UTF8 = new TextDecoder("utf-8", { fatal: true });

function fail(invariant) {
  throw new Error(`Release archive invariant violated: ${invariant}.`);
}

function bytes(value) {
  if (!(value instanceof Uint8Array)) throw new TypeError("archiveBytes must be a Uint8Array");
  return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
}

function limits(value) {
  if (value === undefined) return DEFAULT_LIMITS;
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError("limits must be an object");
  const result = { ...DEFAULT_LIMITS };
  for (const [key, ceiling] of Object.entries(value)) {
    if (!Object.hasOwn(result, key) || !Number.isSafeInteger(ceiling) || ceiling <= 0) throw new TypeError("limits contain an invalid ceiling");
    result[key] = ceiling;
  }
  return result;
}

let crcTable;
function crc32(input) {
  if (crcTable === undefined) {
    crcTable = Array.from({ length: 256 }, (_, index) => {
      let value = index;
      for (let bit = 0; bit < 8; bit += 1) value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
      return value >>> 0;
    });
  }
  let crc = 0xffffffff;
  for (const value of input) crc = crcTable[(crc ^ value) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function skipGzipText(input, offset, ceiling) {
  const end = Math.min(input.length, offset + ceiling + 1);
  const nul = input.indexOf(0, offset);
  if (nul < offset || nul >= end) fail("gzip metadata is malformed or oversized");
  return nul + 1;
}

function inflateGzip(input, ceiling) {
  if (input.length > ceiling.compressedBytes) fail("compressed input exceeds its size ceiling");
  if (input.length >= 2 && (input[0] !== 0x1f || input[1] !== 0x8b)) fail("gzip framing is malformed");
  if (input.length < 18) fail("gzip payload is truncated");
  if (input[2] !== 8) fail("gzip framing is malformed");
  const flags = input[3];
  if ((flags & 0xe0) !== 0 || (flags & 0x02) !== 0) fail("gzip flags are unsupported");
  let offset = 10;
  let metadata = 0;
  if ((flags & 0x04) !== 0) {
    if (offset + 2 > input.length) fail("gzip metadata is malformed");
    const length = input.readUInt16LE(offset);
    offset += 2;
    metadata += length + 2;
    if (metadata > ceiling.gzipMetadataBytes || offset + length > input.length) fail("gzip metadata is malformed or oversized");
    offset += length;
  }
  for (const flag of [0x08, 0x10]) {
    if ((flags & flag) === 0) continue;
    const before = offset;
    offset = skipGzipText(input, offset, ceiling.gzipMetadataBytes - metadata);
    metadata += offset - before;
  }
  if (offset + 8 > input.length) fail("gzip payload is truncated");

  let inflated;
  try {
    inflated = inflateRawSync(input.subarray(offset), { info: true, maxOutputLength: ceiling.expandedBytes });
  } catch {
    fail("gzip payload is malformed or exceeds its size ceiling");
  }
  const consumed = inflated.engine.bytesWritten;
  const trailer = offset + consumed;
  if (trailer + 8 !== input.length) fail("gzip contains trailing or concatenated data");
  const output = Buffer.from(inflated.buffer);
  if (input.readUInt32LE(trailer) !== crc32(output) || input.readUInt32LE(trailer + 4) !== (output.length >>> 0)) {
    fail("gzip integrity check failed");
  }
  return output;
}

function fieldText(header, start, length, label) {
  const field = header.subarray(start, start + length);
  const nul = field.indexOf(0);
  const end = nul === -1 ? field.length : nul;
  if (nul !== -1 && field.subarray(nul).some((value) => value !== 0)) fail(`${label} field is malformed`);
  try {
    return UTF8.decode(field.subarray(0, end));
  } catch {
    fail(`${label} is not valid UTF-8`);
  }
}

function octal(header, start, length, label, allowEmpty = false, allowNulZero = false) {
  const field = header.subarray(start, start + length);
  if ((field[0] & 0x80) !== 0) fail(`${label} uses unsupported numeric encoding`);
  if (field.some((value) => value !== 0 && value !== 0x20 && (value < 0x30 || value > 0x37))) {
    fail(`${label} field is malformed`);
  }
  if (allowNulZero && allZero(field)) return 0;
  const text = Buffer.from(field).toString("ascii").replace(/[\0 ]+$/u, "").replace(/^ +/u, "");
  if (text.length === 0) {
    if (allowEmpty) return 0;
    fail(`${label} field is malformed`);
  }
  if (!/^[0-7]+$/u.test(text)) fail(`${label} field is malformed`);
  const value = Number.parseInt(text, 8);
  if (!Number.isSafeInteger(value)) fail(`${label} exceeds its numeric ceiling`);
  return value;
}

function normalizedName(value, directory) {
  let name = value;
  if (directory && name.endsWith("/")) name = name.slice(0, -1);
  if (name.length === 0 || name !== name.normalize("NFC") || CONTROL.test(name) || name.includes("\\")
      || name.startsWith("/") || /^[A-Za-z]:/u.test(name)) fail("member path is not normalized and relative");
  const parts = name.split("/");
  if (parts.some((part) => part.length === 0 || part === "." || part === "..")) fail("member path traverses or contains an empty segment");
  return name;
}

function portableFold(name) {
  return name.toUpperCase().toLowerCase();
}

function checksum(header) {
  let sum = 0;
  for (let index = 0; index < header.length; index += 1) sum += index >= 148 && index < 156 ? 0x20 : header[index];
  return sum;
}

function allZero(input) {
  return input.every((value) => value === 0);
}

export function inspectTarball(archiveBytes, options = {}) {
  if (options === null || typeof options !== "object" || Array.isArray(options)) throw new TypeError("options must be an object");
  const ceiling = limits(options.limits);
  const tar = inflateGzip(bytes(archiveBytes), ceiling);
  const files = new Map();
  const seen = new Set();
  const folded = new Set();
  const regularFolds = new Set();
  const directoryFolds = new Set();
  const roots = new Set();
  let offset = 0;
  let entries = 0;
  let totalFileBytes = 0;
  let terminated = false;

  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (allZero(header)) {
      if (offset + 1024 > tar.length || !allZero(tar.subarray(offset + 512, offset + 1024)) || !allZero(tar.subarray(offset + 1024))) {
        fail("tar termination or trailing padding is malformed");
      }
      terminated = true;
      break;
    }
    entries += 1;
    if (entries > ceiling.entries) fail("member count exceeds its ceiling");
    if (fieldText(header, 257, 6, "tar magic") !== "ustar" || fieldText(header, 263, 2, "tar version") !== "00") {
      fail("tar header format is unsupported");
    }
    const recordedChecksum = octal(header, 148, 8, "tar checksum");
    if (recordedChecksum !== checksum(header)) fail("tar header checksum is invalid");
    const mode = octal(header, 100, 8, "mode");
    const uid = octal(header, 108, 8, "uid", false, true);
    const gid = octal(header, 116, 8, "gid", false, true);
    const size = octal(header, 124, 12, "member size");
    const mtime = octal(header, 136, 12, "mtime");
    const deviceMajor = octal(header, 329, 8, "device major", true);
    const deviceMinor = octal(header, 337, 8, "device minor", true);
    if (mode > 0o7777 || uid > 0x7fffffff || gid > 0x7fffffff || mtime > 0x1ffffffff) {
      fail("tar numeric metadata exceeds its ceiling");
    }
    if (size > ceiling.memberBytes) fail("member size exceeds its ceiling");
    const type = header[156];
    const regular = type === 0 || type === 0x30;
    const directory = type === 0x35;
    if (!regular && !directory) fail("links, devices, and metadata extensions are unsupported");
    if (directory && size !== 0) fail("directory member carries file data");
    const nameField = fieldText(header, 0, 100, "member name");
    const linkName = fieldText(header, 157, 100, "link name");
    fieldText(header, 265, 32, "owner name");
    fieldText(header, 297, 32, "group name");
    const prefix = fieldText(header, 345, 155, "member prefix");
    if (linkName.length !== 0 || deviceMajor !== 0 || deviceMinor !== 0) fail("regular or directory member carries contradictory metadata");
    if (!allZero(header.subarray(500, 512))) fail("tar reserved header bytes are nonzero");
    const name = normalizedName(prefix.length === 0 ? nameField : `${prefix}/${nameField}`, directory);
    const fold = portableFold(name);
    if (seen.has(name)) fail("duplicate member path");
    if (folded.has(fold)) fail("portable case-colliding member paths");
    const foldedAncestors = fold.split("/").slice(0, -1).map((_, index, parts) => parts.slice(0, index + 1).join("/"));
    if (foldedAncestors.some((ancestor) => regularFolds.has(ancestor))
        || (regular && [...folded].some((existing) => existing.startsWith(`${fold}/`)))) {
      fail("regular file conflicts with a descendant member");
    }
    seen.add(name);
    folded.add(fold);
    if (regular) regularFolds.add(fold);
    else directoryFolds.add(fold);
    roots.add(name.split("/", 1)[0]);

    const bodyStart = offset + 512;
    const padded = Math.ceil(size / 512) * 512;
    if (!Number.isSafeInteger(padded) || bodyStart + padded > tar.length) fail("member data is truncated");
    if (!allZero(tar.subarray(bodyStart + size, bodyStart + padded))) fail("member padding is malformed");
    if (regular) {
      totalFileBytes += size;
      if (totalFileBytes > ceiling.totalFileBytes) fail("aggregate file data exceeds its ceiling");
      files.set(name, Buffer.from(tar.subarray(bodyStart, bodyStart + size)));
    }
    offset = bodyStart + padded;
  }
  if (!terminated) fail("tar archive has no strict end marker");
  const necessaryDirectoryFolds = new Set();
  for (const file of regularFolds) {
    const parts = file.split("/");
    for (let length = 1; length < parts.length; length += 1) necessaryDirectoryFolds.add(parts.slice(0, length).join("/"));
  }
  for (const directory of directoryFolds) {
    if (!necessaryDirectoryFolds.has(directory)) fail("explicit directory is not a necessary ancestor of a regular file");
  }
  if (roots.size !== 1) fail("archive has ambiguous package roots");
  const root = roots.values().next().value;
  const relativeFiles = new Map();
  for (const [name, content] of files) {
    if (name === root || !name.startsWith(`${root}/`)) fail("regular file is not beneath the package root");
    relativeFiles.set(name.slice(root.length + 1), content);
  }
  return { root, files: relativeFiles };
}

export const TARBALL_INSPECTION_LIMITS = DEFAULT_LIMITS;

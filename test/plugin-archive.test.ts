import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { deflateRawSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as archiveApi from "../src/plugin-lifecycle/acquisition/archive.js";
import { acquireHttpsZipPlugin, parseZipPluginTree } from "../src/plugin-lifecycle/acquisition/archive.js";
import { acquireLocalMarketplaceSnapshot } from "../src/plugin-lifecycle/acquisition/local.js";
import { createLifecycleLocations } from "../src/plugin-lifecycle/locations.js";
import { establishOwnedStateStore, type OwnedStateStore } from "../src/plugin-lifecycle/state-store.js";
import type { HttpConnector, HttpResolver } from "../src/plugin-lifecycle/acquisition/http.js";

const roots: string[] = [];
function temporaryRoot(): string {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "picc-archive-")));
  roots.push(root);
  return root;
}
async function ownedStore(root: string): Promise<OwnedStateStore> {
  const locations = createLifecycleLocations({ homeDir: root, profilePath: path.join(root, ".claude"), platform: process.platform === "win32" ? "win32" : "posix" });
  if (!locations.ok) throw new Error(locations.error.message);
  const result = await establishOwnedStateStore(locations.value, root);
  if (!result.ok) throw new Error(result.message);
  return result.value;
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const CRC_TABLE = new Uint32Array(256);
for (let value = 0; value < 256; value += 1) {
  let crc = value;
  for (let bit = 0; bit < 8; bit += 1) crc = (crc & 1) === 0 ? crc >>> 1 : (crc >>> 1) ^ 0xedb88320;
  CRC_TABLE[value] = crc >>> 0;
}
function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ byte) & 0xff]!;
  return (crc ^ 0xffffffff) >>> 0;
}
interface ZipEntry {
  readonly name: string;
  readonly data?: string | Uint8Array;
  readonly method?: number;
  readonly flags?: number;
  readonly mode?: number;
  readonly declaredSize?: number;
  readonly corruptCrc?: boolean;
  readonly compressedSizeForRatio?: number;
}
function zip(entries: readonly ZipEntry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const item of entries) {
    const name = Buffer.from(item.name, "utf8");
    const data = typeof item.data === "string" ? Buffer.from(item.data) : Buffer.from(item.data ?? new Uint8Array());
    const method = item.method ?? 0;
    const encoded = method === 8 ? deflateRawSync(data) : data;
    if (item.compressedSizeForRatio !== undefined && item.compressedSizeForRatio < encoded.byteLength) throw new Error("ratio fixture target is too small");
    const compressed = item.compressedSizeForRatio === undefined
      ? encoded
      : Buffer.concat([encoded, Buffer.alloc(item.compressedSizeForRatio - encoded.byteLength)]);
    const crc = (crc32(data) + (item.corruptCrc === true ? 1 : 0)) >>> 0;
    const declared = item.declaredSize ?? data.byteLength;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(item.flags ?? 0, 6);
    local.writeUInt16LE(method, 8); local.writeUInt32LE(crc, 14); local.writeUInt32LE(compressed.byteLength, 18);
    local.writeUInt32LE(declared, 22); local.writeUInt16LE(name.byteLength, 26);
    locals.push(local, name, compressed);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE((3 << 8) | 20, 4); central.writeUInt16LE(20, 6);
    central.writeUInt16LE(item.flags ?? 0, 8); central.writeUInt16LE(method, 10); central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.byteLength, 20); central.writeUInt32LE(declared, 24); central.writeUInt16LE(name.byteLength, 28);
    const mode = item.mode ?? (item.name.endsWith("/") ? 0o040755 : 0o100644);
    central.writeUInt32LE((mode << 16) >>> 0, 38); central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += local.byteLength + name.byteLength + compressed.byteLength;
  }
  const centralBytes = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBytes.byteLength, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBytes, end]);
}

const resolver: HttpResolver = async () => [{ address: "93.184.216.34", family: 4 }];
function connector(bytes: Uint8Array): HttpConnector {
  return async () => ({ status: 200, headers: {}, body: Uint8Array.from(bytes) });
}
const INVALID_ARCHIVE = { ok: false, error: { code: "invalid-archive", message: "The ZIP artifact is malformed, unsupported, or unsafe" } } as const;
const ARCHIVE_LIMIT = { ok: false, error: { code: "limit-exceeded", message: "The ZIP artifact exceeds portable archive limits" } } as const;
const INVALID_ARCHIVE_ROOT = { ok: false, error: { code: "invalid-archive", message: "The ZIP artifact does not contain one portable root-or-wrapper plugin tree" } } as const;

function pluginZip(prefix = ""): Buffer {
  return zip([
    { name: `${prefix}.claude-plugin/`, mode: 0o040755 },
    { name: `${prefix}.claude-plugin/plugin.json`, data: "{}" },
    { name: `${prefix}bin/run`, data: "run", method: 8, mode: 0o100755 },
  ]);
}

describe("lazy ZIP plugin acquisition", () => {
  it("materializes exact root and one-wrapper layouts and binds artifact integrity/root evidence", async () => {
    const root = temporaryRoot();
    const store = await ownedStore(root);
    for (const source of [
      { kind: "https-zip", url: "https://archive.example.org/plugin", canary: "not-evidence" },
      { kind: "https-zip", url: "https://archive.example.org/plugin?token=canary" },
      { kind: "https-zip", url: "https://archive.example.org/plugin\n" },
    ]) {
      expect(await acquireHttpsZipPlugin(source as never, { store, resolver, connector: connector(pluginZip()) }))
        .toMatchObject({ ok: false, error: { code: "unsafe-source" } });
    }
    const unwrapped = pluginZip();
    const wrapped = pluginZip("package/");
    for (const [bytes, expectedPath] of [[unwrapped, ""], [wrapped, "package"]] as const) {
      const hex = createHash("sha256").update(bytes).digest("hex");
      const result = await acquireHttpsZipPlugin(
        { kind: "https-zip", url: "https://archive.example.org/plugin", sha256: hex },
        { store, resolver, connector: connector(bytes) },
      );
      expect(result.ok).toBe(true);
      if (!result.ok) continue;
      expect(result.value.artifactDigest).toBe(`sha256:${hex}`);
      expect(result.value.provenance.selectedRoot).toEqual({ requested: "root-or-single-wrapper", path: expectedPath, usedSingleWrapper: expectedPath !== "" });
      expect(fs.readFileSync(path.join(result.value.materialized.pluginRoot, "bin", "run"), "utf8")).toBe("run");
      if (process.platform !== "win32") expect(fs.statSync(path.join(result.value.materialized.pluginRoot, "bin", "run")).mode & 0o111).not.toBe(0);
    }
  });

  it("rejects mismatched integrity, deeper guessing, malformed/truncated data, and CRC corruption", async () => {
    const root = temporaryRoot();
    const store = await ownedStore(root);
    const bytes = pluginZip();
    expect(await acquireHttpsZipPlugin(
      { kind: "https-zip", url: "https://archive.example.org/plugin", sha256: "0".repeat(64) },
      { store, resolver, connector: connector(bytes) },
    )).toMatchObject({ ok: false, error: { code: "integrity" } });
    const deeper = pluginZip("outer/package/");
    expect(await acquireHttpsZipPlugin(
      { kind: "https-zip", url: "https://archive.example.org/plugin" },
      { store, resolver, connector: connector(deeper) },
    )).toEqual(INVALID_ARCHIVE_ROOT);
    expect(await parseZipPluginTree(bytes.subarray(0, bytes.length - 8))).toEqual(INVALID_ARCHIVE);
    expect(await parseZipPluginTree(Buffer.from("not a zip"))).toEqual(INVALID_ARCHIVE);
    expect(await parseZipPluginTree(zip([{ name: ".claude-plugin/plugin.json", data: "{}", corruptCrc: true }]))).toEqual(INVALID_ARCHIVE);
  });

  it("rejects traversal, portable collisions, links/specials, encryption, unsupported methods, and bombs", async () => {
    const unsafe = [
      zip([{ name: "../escape", data: "x" }]),
      zip([{ name: "A/file", data: "x" }, { name: "a/FILE", data: "y" }]),
      zip([{ name: ".claude-plugin/plugin.json", data: "{}" }, { name: "link", data: "target", mode: 0o120777 }]),
      zip([{ name: ".claude-plugin/plugin.json", data: "{}" }, { name: "fifo", mode: 0o010644 }]),
      zip([{ name: ".claude-plugin/plugin.json", data: "{}" }, { name: "device", mode: 0o020644 }]),
      zip([{ name: ".claude-plugin/plugin.json", data: "{}" }, { name: "block-device", mode: 0o060000 }]),
      zip([{ name: ".claude-plugin/plugin.json", data: "{}" }, { name: "socket", mode: 0o140644 }]),
      zip([{ name: ".claude-plugin/", mode: 0o100644 }]),
      zip([{ name: ".claude-plugin", mode: 0o040755 }]),
      zip([{ name: ".claude-plugin/plugin.json", data: "{}", flags: 1 }]),
      zip([{ name: ".claude-plugin/plugin.json", data: "{}", method: 99 }]),
    ];
    for (const [index, bytes] of unsafe.entries()) {
      expect(await parseZipPluginTree(bytes), `unsafe ZIP row ${index}`).toEqual(INVALID_ARCHIVE);
    }
  });

  it("enforces parser entry, declared-size, total-size, and compression-ratio exact and plus-one boundaries", async () => {
    const exactEntries = Array.from({ length: 10_000 }, (_, index) => ({ name: `f-${index}`, data: "" }));
    expect((await parseZipPluginTree(zip(exactEntries))).ok).toBe(true);
    expect(await parseZipPluginTree(zip([...exactEntries, { name: "overflow", data: "" }]))).toEqual(ARCHIVE_LIMIT);

    const maximum = new Uint8Array(8 * 1024 * 1024);
    expect((await parseZipPluginTree(zip([{ name: "maximum", data: maximum }]))).ok).toBe(true);
    expect(await parseZipPluginTree(zip([{ name: "excessive", data: new Uint8Array(maximum.byteLength + 1) }]))).toEqual(ARCHIVE_LIMIT);
    expect((await parseZipPluginTree(zip([{ name: "one", data: maximum }, { name: "two", data: maximum }]))).ok).toBe(true);
    expect(await parseZipPluginTree(zip([{ name: "one", data: maximum }, { name: "two", data: maximum }, { name: "plus-one", data: "x" }]))).toEqual(ARCHIVE_LIMIT);

    const compressible = new Uint8Array(20_000);
    expect((await parseZipPluginTree(zip([{ name: "ratio-exact", data: compressible, method: 8, compressedSizeForRatio: 100 }]))).ok).toBe(true);
    expect(await parseZipPluginTree(zip([{ name: "ratio-plus", data: compressible, method: 8, compressedSizeForRatio: 99 }]))).toEqual(ARCHIVE_LIMIT);
  });

  it("honors preflight and in-flight cancellation without exposing an extraction-to-files API", async () => {
    const controller = new AbortController();
    controller.abort();
    expect(await parseZipPluginTree(pluginZip(), controller.signal)).toMatchObject({ ok: false, error: { code: "cancelled" } });
    const inFlight = new AbortController();
    const parsing = parseZipPluginTree(zip([{ name: ".claude-plugin/plugin.json", data: new Uint8Array(1024 * 1024), method: 8 }]), inFlight.signal);
    queueMicrotask(() => inFlight.abort());
    expect(await parsing).toMatchObject({ ok: false, error: { code: "cancelled" } });
    expect(Object.keys(archiveApi).sort()).toEqual(["acquireHttpsZipPlugin", "parseZipPluginTree"]);
  });

  it("discards exact staging when cancellation arrives after ZIP materialization", async () => {
    const root = temporaryRoot(); const store = await ownedStore(root); const controller = new AbortController();
    const original = fs.promises.lstat.bind(fs.promises); let stagingPath = ""; let stagingStats = 0;
    vi.spyOn(fs.promises, "lstat").mockImplementation((async (candidate, options) => {
      if (path.basename(String(candidate)).startsWith(".picc-staging-")) {
        stagingPath = String(candidate); stagingStats += 1;
        if (stagingStats === 3) controller.abort();
      }
      return await original(candidate, options as never);
    }) as typeof fs.promises.lstat);
    const result = await acquireHttpsZipPlugin(
      { kind: "https-zip", url: "https://archive.example.org/plugin" },
      { store, signal: controller.signal, resolver, connector: connector(pluginZip()) },
    );
    expect(result).toMatchObject({ ok: false, error: { code: "cancelled" } });
    expect(stagingPath).not.toBe("");
    expect(fs.existsSync(stagingPath)).toBe(false);
  });

  it("gives changed local catalogs distinct immutable catalog snapshot identifiers", async () => {
    const root = temporaryRoot();
    const marketplace = path.join(root, "marketplace");
    fs.mkdirSync(path.join(marketplace, ".claude-plugin"), { recursive: true });
    const catalog = path.join(marketplace, ".claude-plugin", "marketplace.json");
    fs.writeFileSync(catalog, '{"name":"one","plugins":[]}');
    const store = await ownedStore(root);
    const first = await acquireLocalMarketplaceSnapshot(
      { kind: "local-directory", path: marketplace },
      { store },
    );
    fs.writeFileSync(catalog, '{"name":"two","plugins":[]}');
    const second = await acquireLocalMarketplaceSnapshot(
      { kind: "local-directory", path: marketplace },
      { store },
    );
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.value.catalogDigest).not.toBe(second.value.catalogDigest);
    expect(first.value.snapshotId).not.toBe(second.value.snapshotId);
  });
});

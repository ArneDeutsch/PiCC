import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { verifyRuntimeArtifact } from "../scripts/runtime-artifact.mjs";
import { inspectTarball } from "../scripts/tarball-inspect.mjs";

const PACKAGE = { name: "picc", version: "1.2.3", type: "module" } as const;
const sha = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");
const content = (value: string) => Buffer.from(value, "utf8");
const octal = (value: number, width: number) => `${value.toString(8).padStart(width - 1, "0")}\0`;
const checksumField = (value: number) => `${value.toString(8).padStart(6, "0")}\0 `;

type TarEntry = { name: string; bytes?: Buffer; type?: number; prefix?: string; size?: number; header?: (value: Buffer) => void };
function tar(entries: TarEntry[], { end = true } = {}) {
  const chunks: Buffer[] = [];
  for (const entry of entries) {
    const body = entry.bytes ?? Buffer.alloc(0);
    const header = Buffer.alloc(512);
    header.write(entry.name, 0, 100, "utf8");
    header.write(octal(0o644, 8), 100, 8, "ascii");
    header.write(octal(0, 8), 108, 8, "ascii");
    header.write(octal(0, 8), 116, 8, "ascii");
    header.write(octal(entry.size ?? body.length, 12), 124, 12, "ascii");
    header.write(octal(0, 12), 136, 12, "ascii");
    header.fill(0x20, 148, 156);
    header[156] = entry.type ?? 0x30;
    header.write("ustar\0", 257, 6, "ascii");
    header.write("00", 263, 2, "ascii");
    if (entry.prefix) header.write(entry.prefix, 345, 155, "utf8");
    entry.header?.(header);
    const checksum = [...header].reduce((sum, value) => sum + value, 0);
    header.write(checksumField(checksum), 148, 8, "ascii");
    chunks.push(header, body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  if (end) chunks.push(Buffer.alloc(1024));
  return Buffer.concat(chunks);
}
function archive(entries: TarEntry[], options?: { end?: boolean }) {
  return gzipSync(tar(entries, options), { level: 9, mtime: 0 } as never);
}
function record(path: string, bytes: Buffer) { return { path, sha256: sha(bytes) }; }
function sorted<T extends { path: string }>(records: T[]) {
  return records.sort((left, right) => Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)));
}

const sourceFiles = new Map([
  ["src/index.ts", content("deliberately invalid TypeScript }}} @@@\n")],
  ["src/plugin-inventory-cli.ts", content("export const inventory = true;\n")],
]);
const runtimeFiles = new Map([
  ["dist/index.js", content("export default function picc() {}\n//# sourceMappingURL=index.js.map\n")],
  ["dist/index.js.map", content(JSON.stringify({ version: 3, file: "index.js", sourceRoot: "", sources: ["../src/index.ts"], names: [], mappings: "" }))],
  ["dist/plugin-inventory-cli.js", content("export const inventory = true;\n//# sourceMappingURL=plugin-inventory-cli.js.map\n")],
  ["dist/plugin-inventory-cli.js.map", content(JSON.stringify({ version: 3, file: "plugin-inventory-cli.js", sources: ["../src/plugin-inventory-cli.ts"], names: [], mappings: "" }))],
  ["picc/index.js", content("export { default } from '../dist/index.js';\n")],
]);
const compiler = {
  typescriptVersion: "7.0.2",
  configPath: "tsconfig.runtime.json",
  configSha256: "1".repeat(64),
  dependencyLockPath: "package-lock.json",
  dependencyLockSha256: "2".repeat(64),
};
const sources = sorted([...sourceFiles].map(([path, bytes]) => record(path, bytes)));
const sourceDigest = sha(JSON.stringify({ package: PACKAGE, compiler, sources }));
const policy = {
  files: ["package.json", "dist/picc-runtime.json", ...runtimeFiles.keys()],
  prefixes: ["src/"],
};

type ArtifactChanges = {
  packageJson?: Record<string, unknown>;
  packageBytes?: Buffer;
  manifestBytes?: Buffer;
  add?: TarEntry[];
  remove?: string[];
  replace?: Map<string, Buffer>;
  transformManifest?: (manifest: any) => void;
  root?: string;
};
function validArtifact(changes: ArtifactChanges = {}) {
  const packageJson = changes.packageJson ?? { ...PACKAGE, main: "picc/index.js", devDependencies: { jiti: "2.7.0" } };
  const files = new Map<string, Buffer>([...sourceFiles, ...runtimeFiles]);
  for (const name of changes.remove ?? []) files.delete(name);
  for (const [name, bytes] of changes.replace ?? []) files.set(name, bytes);
  const runtimeRecords = sorted([...runtimeFiles].map(([path, bytes]) => record(path, bytes)));
  const manifest: any = {
    schemaVersion: 1,
    package: { ...PACKAGE },
    compiler: { ...compiler },
    sources: sources.map((item) => ({ ...item })),
    sourceDigest,
    files: runtimeRecords,
    runtimeDigest: sha(JSON.stringify(runtimeRecords)),
    entries: { extension: "picc/index.js", pluginInventory: "dist/plugin-inventory-cli.js" },
  };
  changes.transformManifest?.(manifest);
  const root = changes.root ?? "package";
  const removed = new Set(changes.remove ?? []);
  const entries = [
    ...(!removed.has("package.json") ? [{ name: `${root}/package.json`, bytes: changes.packageBytes ?? content(JSON.stringify(packageJson)) }] : []),
    ...(!removed.has("dist/picc-runtime.json") ? [{ name: `${root}/dist/picc-runtime.json`, bytes: changes.manifestBytes ?? content(JSON.stringify(manifest)) }] : []),
    ...[...files].map(([name, bytes]) => ({ name: `${root}/${name}`, bytes })),
    ...(changes.add ?? []),
  ];
  return archive(entries);
}
function verify(bytes = validArtifact(), overrides: Record<string, unknown> = {}) {
  return verifyRuntimeArtifact({ archiveBytes: bytes, expectedPackage: PACKAGE, expectedSourceDigest: sourceDigest, filePolicy: policy, ...overrides } as never);
}
function repairRuntimeRecord(manifest: any, name: string, bytes: Buffer) {
  manifest.files.find((item: any) => item.path === name).sha256 = sha(bytes);
  manifest.runtimeDigest = sha(JSON.stringify(manifest.files));
}
function appendRuntimeRecord(manifest: any, name: string, bytes: Buffer) {
  manifest.files.push(record(name, bytes));
  sorted(manifest.files);
  manifest.runtimeDigest = sha(JSON.stringify(manifest.files));
}
function expectInvariant(run: () => unknown, pattern: RegExp) {
  let error: unknown;
  try { run(); } catch (caught) { error = caught; }
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toMatch(pattern);
  expect((error as Error).message.length).toBeLessThan(220);
  expect((error as Error).message).not.toMatch(/[A-Za-z]:\\|\/home\/|\/Users\//u);
}

describe("strict tarball inspection", () => {
  it("exposes bounded regular files beneath one normalized package root", () => {
    const inspected = inspectTarball(archive([
      { name: "package/", type: 0x35 },
      { name: "package/a.txt", bytes: content("a") },
      { name: "b.txt", prefix: "package/deep", bytes: content("b") },
    ]));
    expect(inspected.root).toBe("package");
    expect([...inspected.files].map(([name, bytes]) => [name, bytes.toString("utf8")]))
      .toEqual([["a.txt", "a"], ["deep/b.txt", "b"]]);
  });

  it.each([
    ["absolute", "/package/evil"],
    ["traversal", "package/../evil"],
    ["backslash", "package\\evil"],
    ["Windows absolute", "C:/package/evil"],
    ["empty segment", "package//evil"],
    ["non-NFC", "package/e\u0301vil"],
    ["control", "package/evil\u0001"],
  ])("rejects %s member names", (_label, name) => {
    expectInvariant(() => inspectTarball(archive([{ name, bytes: content("x") }])), /path/u);
  });

  it("rejects duplicates and portable case collisions", () => {
    expectInvariant(() => inspectTarball(archive([
      { name: "package/a", bytes: content("1") }, { name: "package/a", bytes: content("2") },
    ])), /duplicate/u);
    expectInvariant(() => inspectTarball(archive([
      { name: "package/File", bytes: content("1") }, { name: "package/file", bytes: content("2") },
    ])), /case-colliding/u);
  });

  it.each([[0x31, "link"], [0x32, "link"], [0x33, "device"], [0x34, "device"], [0x36, "device"], [0x78, "metadata"]])
    ("rejects unsupported type %s (%s)", (type) => {
      expectInvariant(() => inspectTarball(archive([{ name: "package/hostile", type, bytes: content("x") }])), /unsupported/u);
    });

  it("rejects malformed headers, framing, termination, and ambiguous roots", () => {
    const badChecksumTar = tar([{ name: "package/a", bytes: content("a") }]);
    badChecksumTar[0] = badChecksumTar[0]! ^ 1;
    expectInvariant(() => inspectTarball(gzipSync(badChecksumTar)), /checksum/u);
    const badCrc = archive([{ name: "package/a", bytes: content("a") }]);
    badCrc[badCrc.length - 8] = badCrc[badCrc.length - 8]! ^ 1;
    expectInvariant(() => inspectTarball(badCrc), /gzip integrity/u);
    const badPaddingTar = tar([{ name: "package/a", bytes: content("a") }]);
    badPaddingTar[513] = 1;
    expectInvariant(() => inspectTarball(gzipSync(badPaddingTar)), /padding/u);
    expectInvariant(() => inspectTarball(archive([{ name: "package/a", bytes: content("a") }], { end: false })), /end marker/u);
    expectInvariant(() => inspectTarball(archive([
      { name: "package/a", bytes: content("a") }, { name: "other/b", bytes: content("b") },
    ])), /ambiguous/u);
  });

  it("rejects regular-file and descendant conflicts in either member order", () => {
    for (const entries of [
      [{ name: "package/a", bytes: content("file") }, { name: "package/a/b", bytes: content("child") }],
      [{ name: "package/a/b", bytes: content("child") }, { name: "package/a", bytes: content("file") }],
      [{ name: "package/A", bytes: content("file") }, { name: "package/a/b", bytes: content("child") }],
      [{ name: "package/a/b", bytes: content("child") }, { name: "package/A", bytes: content("file") }],
    ]) {
      expectInvariant(() => inspectTarball(archive(entries)), /conflicts with a descendant/u);
    }
  });

  it("allows structural directories and rejects explicit directories without regular-file descendants", () => {
    expect(inspectTarball(archive([
      { name: "package/", type: 0x35 },
      { name: "package/src/", type: 0x35 },
      { name: "package/src/nested/", type: 0x35 },
      { name: "package/src/nested/index.ts", bytes: content("source") },
    ])).files.has("src/nested/index.ts")).toBe(true);
    expectInvariant(() => inspectTarball(archive([
      { name: "package/a", bytes: content("file") },
      { name: "package/src/unrecorded/", type: 0x35 },
    ])), /explicit directory/u);
  });

  it("accepts npm portable all-NUL uid and gid fields as zero", () => {
    const inspected = inspectTarball(archive([{ name: "package/a", bytes: content("a"), header: (header) => {
      header.fill(0, 108, 124);
    } }]));
    expect(inspected.files.get("a")?.toString("utf8")).toBe("a");
  });

  it.each([
    ["invalid fixed-field UTF-8", (header: Buffer) => { header[265] = 0xff; }, /UTF-8/u],
    ["non-NUL fixed-field tail", (header: Buffer) => { header[157] = 0; header[158] = 0x61; }, /link name field/u],
    ["base-256 uid", (header: Buffer) => { header[108] = 0x80; }, /numeric encoding/u],
    ["malformed octal gid", (header: Buffer) => { header[116] = 0x38; }, /field is malformed/u],
    ["all-space uid", (header: Buffer) => { header.fill(0x20, 108, 116); }, /field is malformed/u],
    ["partially empty gid", (header: Buffer) => { header.fill(0, 116, 124); header[123] = 0x20; }, /field is malformed/u],
    ["noncanonical NUL-prefixed uid", (header: Buffer) => { header.fill(0, 108, 116); header[109] = 0x30; }, /field is malformed/u],
    ["base-256 device number", (header: Buffer) => { header[329] = 0x80; }, /numeric encoding/u],
    ["malformed octal device number", (header: Buffer) => { header[329] = 0x38; }, /field is malformed/u],
    ["nonzero link metadata", (header: Buffer) => { header[157] = 0x61; }, /contradictory metadata/u],
    ["nonzero device metadata", (header: Buffer) => { header.write(octal(1, 8), 329, 8, "ascii"); }, /contradictory metadata/u],
    ["nonzero reserved bytes", (header: Buffer) => { header[500] = 1; }, /reserved/u],
  ])("rejects %s", (_label, mutate, pattern) => {
    expectInvariant(() => inspectTarball(archive([{ name: "package/a", bytes: content("a"), header: mutate }])), pattern);
  });

  it("does not extend all-NUL zero to required numeric fields", () => {
    for (const [start, end] of [[100, 108], [124, 136], [136, 148]]) {
      expectInvariant(() => inspectTarball(archive([{ name: "package/a", bytes: content("a"), header: (header) => {
        header.fill(0, start, end);
      } }])), /field is malformed/u);
    }
    const emptyChecksum = tar([{ name: "package/a", bytes: content("a") }]);
    emptyChecksum.fill(0, 148, 156);
    expectInvariant(() => inspectTarball(gzipSync(emptyChecksum)), /checksum field is malformed/u);
  });

  it("distinguishes ustar magic, version, directory data, truncation, and malformed termination", () => {
    expectInvariant(() => inspectTarball(archive([{ name: "package/a", header: (h) => h.write("xxxxx\0", 257, 6, "ascii") }])), /header format/u);
    expectInvariant(() => inspectTarball(archive([{ name: "package/a", header: (h) => h.write("99", 263, 2, "ascii") }])), /header format/u);
    expectInvariant(() => inspectTarball(archive([{ name: "package/dir/", type: 0x35, bytes: content("x") }])), /directory member carries file data/u);
    const truncatedMember = tar([{ name: "package/a", bytes: content("x"), size: 513 }]).subarray(0, 1000);
    expectInvariant(() => inspectTarball(gzipSync(truncatedMember)), /member data is truncated/u);
    const malformedEnd = tar([{ name: "package/a", bytes: content("x") }]);
    malformedEnd[malformedEnd.length - 1] = 1;
    expectInvariant(() => inspectTarball(gzipSync(malformedEnd)), /termination/u);
  });

  it("distinguishes gzip magic, flags, truncation, trailing bytes, and concatenation", () => {
    const good = archive([{ name: "package/a", bytes: content("a") }]);
    const magic = Buffer.from(good); magic[0] = 0;
    expectInvariant(() => inspectTarball(magic), /framing/u);
    const flags = Buffer.from(good); flags[3] = flags[3]! | 0x20;
    expectInvariant(() => inspectTarball(flags), /flags/u);
    expectInvariant(() => inspectTarball(good.subarray(0, 12)), /truncated|malformed/u);
    expectInvariant(() => inspectTarball(Buffer.concat([good, Buffer.from([0])])), /trailing or concatenated/u);
    expectInvariant(() => inspectTarball(Buffer.concat([good, good])), /trailing or concatenated/u);
  });

  it("enforces compressed, expanded, member, metadata, and count ceilings before exposure", () => {
    const one = archive([{ name: "package/a", bytes: content("1234") }]);
    expectInvariant(() => inspectTarball(one, { limits: { compressedBytes: one.length - 1 } }), /compressed input/u);
    expectInvariant(() => inspectTarball(one, { limits: { expandedBytes: 100 } }), /size ceiling/u);
    expectInvariant(() => inspectTarball(one, { limits: { memberBytes: 3 } }), /member size/u);
    const two = archive([
      { name: "package/a", bytes: content("123") }, { name: "package/b", bytes: content("456") },
    ]);
    expectInvariant(() => inspectTarball(two, { limits: { entries: 1 } }), /member count/u);
    expectInvariant(() => inspectTarball(two, { limits: { totalFileBytes: 5 } }), /aggregate file data/u);
    const numeric = tar([{ name: "package/a", bytes: content("a") }]);
    numeric.write(octal(0o10000, 8), 100, 8, "ascii");
    numeric.fill(0x20, 148, 156);
    numeric.write(checksumField([...numeric.subarray(0, 512)].reduce((sum, value) => sum + value, 0)), 148, 8, "ascii");
    expectInvariant(() => inspectTarball(gzipSync(numeric)), /numeric metadata/u);
    const named = Buffer.concat([one.subarray(0, 3), Buffer.from([one[3]! | 0x08]), one.subarray(4, 10), content("metadata-too-long\0"), one.subarray(10)]);
    expectInvariant(() => inspectTarball(named, { limits: { gzipMetadataBytes: 4 } }), /metadata/u);
  });
});

describe("schema-v1 runtime artifact policy", () => {
  it("accepts independently authored runtime bytes and retained source as inert content", () => {
    const result = verify();
    expect(result.package).toEqual(PACKAGE);
    expect(result.manifest.schemaVersion).toBe(1);
    expect(result.manifest.sourceDigest).toBe(sourceDigest);
    expect(result.files.get("src/index.ts")?.equals(sourceFiles.get("src/index.ts")!)).toBe(true);
  });

  it.each([
    ["missing runtime", { remove: ["dist/index.js"] }, /required product|generated runtime|integrity/u],
    ["missing map", { remove: ["dist/index.js.map"] }, /required product|generated runtime|integrity/u],
    ["corrupt runtime", { replace: new Map([["dist/index.js", content("corrupt")]]) }, /integrity/u],
    ["corrupt map", { replace: new Map([["dist/index.js.map", content("corrupt")]]) }, /integrity/u],
    ["missing retained source", { remove: ["src/index.ts"] }, /retained source/u],
  ])("rejects %s", (_label, changes, pattern) => {
    expectInvariant(() => verify(validArtifact(changes as ArtifactChanges)), pattern as RegExp);
  });

  it.each([
    ["dist/index.js", "extension runtime"],
    ["dist/index.js.map", "extension map"],
    ["dist/plugin-inventory-cli.js", "plugin runtime"],
    ["dist/plugin-inventory-cli.js.map", "plugin map"],
    ["picc/index.js", "wrapper"],
  ])("rejects missing and corrupt required %s (%s)", (name) => {
    expectInvariant(() => verify(validArtifact({ remove: [name] })), /generated runtime contents are missing/u);
    expectInvariant(() => verify(validArtifact({ replace: new Map([[name, content("corrupt")]]) })), /generated runtime failed its integrity/u);
  });

  it("fatally decodes package, manifest, and map JSON bytes as UTF-8", () => {
    expectInvariant(() => verify(validArtifact({ packageBytes: Buffer.from([0x7b, 0xff, 0x7d]) })), /package metadata is not valid UTF-8/u);
    expectInvariant(() => verify(validArtifact({ manifestBytes: Buffer.from([0x7b, 0xff, 0x7d]) })), /runtime identity is not valid UTF-8/u);
    const invalidMap = Buffer.from([0x7b, 0xff, 0x7d]);
    expectInvariant(() => verify(validArtifact({
      replace: new Map([["dist/index.js.map", invalidMap]]),
      transformManifest: (manifest) => repairRuntimeRecord(manifest, "dist/index.js.map", invalidMap),
    })), /runtime source map is not valid UTF-8/u);
  });

  it("rejects stale source identity, package mismatch, and runtime/package version mismatch", () => {
    expectInvariant(() => verify(validArtifact(), { expectedSourceDigest: "f".repeat(64) }), /source identity/u);
    expectInvariant(() => verify(validArtifact({ packageJson: { ...PACKAGE, version: "9.9.9" } })), /package identity/u);
    expectInvariant(() => verify(validArtifact({ transformManifest: (manifest) => {
      manifest.package.version = "9.9.9";
      manifest.sourceDigest = sha(JSON.stringify({ package: manifest.package, compiler: manifest.compiler, sources: manifest.sources }));
    } })), /runtime and package identities/u);
  });

  it.each(["dist/forgotten.js", "picc/forgotten.js"])(
    "rejects unexpected generated output %s even when the caller policy allows its prefix",
    (name) => {
      const extra = { name: `package/${name}`, bytes: content("unexpected") };
      expectInvariant(() => verify(validArtifact({ add: [extra] }), {
        filePolicy: { files: policy.files, prefixes: ["src/", "dist/", "picc/"] },
      }), /generated runtime contents/u);
    },
  );

  it("distinguishes malformed or unsupported schemas, fixed entries, and required records", () => {
    expectInvariant(() => verify(validArtifact({ transformManifest: (manifest) => { manifest.schemaVersion = 2; } })), /unsupported schema/u);
    expectInvariant(() => verify(validArtifact({ transformManifest: (manifest) => { manifest.schemaVersion = "1"; } })), /identity is malformed/u);
    expectInvariant(() => verify(validArtifact({ transformManifest: (manifest) => { manifest.schemaVersion = null; } })), /identity is malformed/u);
    expectInvariant(() => verify(validArtifact({ transformManifest: (manifest) => { manifest.schemaVersion = 0; } })), /identity is malformed/u);
    expectInvariant(() => verify(validArtifact({ transformManifest: (manifest) => { manifest.schemaVersion = -1; } })), /identity is malformed/u);
    expectInvariant(() => verify(validArtifact({ transformManifest: (manifest) => { manifest.schemaVersion = Number.MAX_SAFE_INTEGER + 1; } })), /identity is malformed/u);
    expectInvariant(() => verify(validArtifact({ transformManifest: (manifest) => { manifest.extra = true; } })), /identity is malformed/u);
    expectInvariant(() => verify(validArtifact({ transformManifest: (manifest) => { delete manifest.compiler.configPath; } })), /identity is malformed/u);
    expectInvariant(() => verify(validArtifact({ transformManifest: (manifest) => { manifest.entries.extension = "dist/index.js"; } })), /fixed entrypoints/u);
    expectInvariant(() => verify(validArtifact({ transformManifest: (manifest) => { manifest.entries.pluginInventory = "dist/index.js"; } })), /fixed entrypoints/u);
    expectInvariant(() => verify(validArtifact({ transformManifest: (manifest) => {
      manifest.files = manifest.files.filter((item: any) => item.path !== "picc/index.js");
      manifest.runtimeDigest = sha(JSON.stringify(manifest.files));
    } })), /required runtime record/u);
  });

  it.each([
    ["record order", (manifest: any) => { manifest.sources.reverse(); }],
    ["record path", (manifest: any) => { manifest.sources[0].path = "../escape.ts"; }],
    ["record collision", (manifest: any) => { manifest.sources[1].path = manifest.sources[0].path.toUpperCase(); }],
    ["record extra key", (manifest: any) => { manifest.files[0].extra = true; }],
  ])("rejects malformed %s", (_label, transformManifest) => {
    expectInvariant(() => verify(validArtifact({ transformManifest })), /identity is malformed/u);
  });

  it("distinguishes inconsistent source and runtime digests", () => {
    expectInvariant(() => verify(validArtifact({ transformManifest: (manifest) => { manifest.sourceDigest = "a".repeat(64); } }), {
      expectedSourceDigest: "a".repeat(64),
    }), /source digest is inconsistent/u);
    expectInvariant(() => verify(validArtifact({ transformManifest: (manifest) => { manifest.runtimeDigest = "b".repeat(64); } })), /runtime digest is inconsistent/u);
  });

  it.each([
    ["dependencies", "jiti"],
    ["optionalDependencies", "jiti"],
    ["dependencies", "JITI"],
  ])("rejects a direct production loader in %s as %s", (field, loader) => {
    expectInvariant(() => verify(validArtifact({ packageJson: { ...PACKAGE, [field]: { [loader]: "2.7.0" } } })), /runtime loader/u);
  });

  it("rejects unsafe and wrong-recorded-source maps even when hashes are self-consistent", () => {
    const unsafeMap = content(JSON.stringify({ version: 3, file: "index.js", sources: ["../../outside.ts"], names: [], mappings: "" }));
    expectInvariant(() => verify(validArtifact({
      replace: new Map([["dist/index.js.map", unsafeMap]]),
      transformManifest: (manifest) => {
        repairRuntimeRecord(manifest, "dist/index.js.map", unsafeMap);
      },
    })), /source map/u);
    const staleMap = content(JSON.stringify({ version: 3, file: "index.js", sources: ["../src/plugin-inventory-cli.ts"], names: [], mappings: "" }));
    expectInvariant(() => verify(validArtifact({
      replace: new Map([["dist/index.js.map", staleMap]]),
      transformManifest: (manifest) => repairRuntimeRecord(manifest, "dist/index.js.map", staleMap),
    })), /exact recorded source/u);
  });

  it("rejects self-consistent orphan maps and mapless JavaScript", () => {
    const orphan = content(JSON.stringify({ version: 3, file: "orphan.js", sources: ["../src/index.ts"], names: [], mappings: "" }));
    expectInvariant(() => verify(validArtifact({
      add: [{ name: "package/dist/orphan.js.map", bytes: orphan }],
      transformManifest: (manifest) => appendRuntimeRecord(manifest, "dist/orphan.js.map", orphan),
    }), { filePolicy: { files: policy.files, prefixes: ["src/", "dist/"] } }), /orphan source map/u);
    const mapless = content("export const orphan = true;\n");
    expectInvariant(() => verify(validArtifact({
      add: [{ name: "package/dist/orphan.js", bytes: mapless }],
      transformManifest: (manifest) => appendRuntimeRecord(manifest, "dist/orphan.js", mapless),
    }), { filePolicy: { files: policy.files, prefixes: ["src/", "dist/"] } }), /missing its source map/u);
  });

  it("rejects corrupt or unexpected retained source independently of generated content", () => {
    expectInvariant(() => verify(validArtifact({ replace: new Map([["src/index.ts", content("different invalid source")]]) })), /retained source failed its integrity/u);
    expectInvariant(() => verify(validArtifact({ add: [{ name: "package/src/unrecorded.txt", bytes: content("not a manifest source") }] })), /retained source set/u);
    expectInvariant(() => verify(validArtifact({ add: [{ name: "package/src/unrecorded.ts", bytes: content("extra") }] })), /retained source set/u);
    expectInvariant(() => verify(validArtifact({ add: [{ name: "package/src/unrecorded/", type: 0x35 }] })), /explicit directory/u);
  });

  it("distinguishes missing package metadata, runtime identity, and non-runtime policy files", () => {
    expectInvariant(() => verify(validArtifact({ remove: ["package.json"] })), /package metadata is missing/u);
    expectInvariant(() => verify(validArtifact({ remove: ["dist/picc-runtime.json"] })), /runtime identity is missing/u);
    const withReadme = validArtifact({ add: [{ name: "package/README.md", bytes: content("readme") }] });
    expectInvariant(() => verify(withReadme, {
      filePolicy: { files: [...policy.files, "README.md", "LICENSE"], prefixes: policy.prefixes },
    }), /required non-runtime policy file is missing/u);
  });

  it("rejects oversized JSON metadata before parsing it", () => {
    expectInvariant(() => verify(validArtifact({
      packageJson: { ...PACKAGE, padding: "x".repeat(1024 * 1024) },
    })), /metadata ceiling/u);
  });

  it("enforces duplicate-free, portable caller policy and canonical npm root", () => {
    expectInvariant(() => verify(validArtifact({ add: [{ name: "package/secrets.txt", bytes: content("no") }] })), /product policy/u);
    expectInvariant(() => verify(validArtifact({ root: "picc" })), /package root/u);
    expect(() => verify(validArtifact(), { filePolicy: { files: ["package.json", "package.json"], prefixes: [] } })).toThrow(/duplicate/u);
    expect(() => verify(validArtifact(), { filePolicy: { files: ["README.md", "readme.md"], prefixes: [] } })).toThrow(/case collision/u);
    expect(() => verify(validArtifact(), { filePolicy: { files: [], prefixes: ["src/", "SRC/"] } })).toThrow(/case-colliding/u);
    expect(() => verify(validArtifact(), { filePolicy: { files: ["package.json"], prefixes: ["../"] } })).toThrow(TypeError);
  });
});

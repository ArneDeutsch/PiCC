import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import * as tar from "tar-stream";
import { afterEach, describe, expect, it } from "vitest";
import {
  acquireResolvedNpmPlugin,
  isNpmPluginAcquisitionEvidence,
  issueNpmPostMaterializationWitnessForTest,
  parseNpmPackageTree,
  resolveNpmPluginSource,
} from "../src/plugin-lifecycle/acquisition/npm.js";
import type { HttpConnector, HttpResolver } from "../src/plugin-lifecycle/acquisition/http.js";
import { createLifecycleLocations } from "../src/plugin-lifecycle/locations.js";
import { establishOwnedStateStore, type OwnedStateStore } from "../src/plugin-lifecycle/state-store.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => await fs.rm(root, { recursive: true, force: true })));
});

async function store(): Promise<OwnedStateStore> {
  const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "picc-npm-acquire-")));
  roots.push(home);
  if (process.platform !== "win32") await fs.chmod(home, 0o700);
  const locations = createLifecycleLocations({
    homeDir: home,
    profilePath: path.join(home, "profile"),
    platform: process.platform === "win32" ? "win32" : "posix",
  });
  if (!locations.ok) throw new Error(locations.error.message);
  const result = await establishOwnedStateStore(locations.value, home);
  if (!result.ok) throw new Error(result.message);
  return result.value;
}

const resolver: HttpResolver = async () => [{ address: "8.8.8.8", family: 4 }];

type TarEntry = {
  readonly name: string;
  readonly body?: string | Uint8Array;
  readonly type?: "file" | "directory" | "symlink" | "link" | "fifo" | "character-device" | "block-device" | "contiguous-file";
  readonly linkname?: string;
  readonly mode?: number;
  readonly size?: number;
};

async function tgz(entries: readonly TarEntry[]): Promise<Buffer> {
  const pack = tar.pack();
  const chunks: Buffer[] = [];
  pack.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
  const completed = new Promise<void>((resolve, reject) => {
    pack.once("end", resolve);
    pack.once("error", reject);
  });
  for (const entry of entries) {
    const body = Buffer.from(entry.body ?? "");
    pack.entry({
      name: entry.name,
      type: entry.type ?? "file",
      size: entry.size ?? ((entry.type ?? "file") === "file" ? body.byteLength : 0),
      ...(entry.linkname === undefined ? {} : { linkname: entry.linkname }),
      ...(entry.mode === undefined ? {} : { mode: entry.mode }),
    }, body);
  }
  pack.finalize();
  await completed;
  return gzipSync(Buffer.concat(chunks));
}

function integrity(bytes: Uint8Array): string {
  return `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
}

async function malformedDirectory(name: string): Promise<Buffer> {
  const raw = gunzipSync(await tgz([{ name, body: "x" }]));
  raw[156] = "5".charCodeAt(0);
  raw.fill(0x20, 148, 156);
  let checksum = 0;
  for (let index = 0; index < 512; index += 1) checksum += raw[index]!;
  raw.write(checksum.toString(8).padStart(6, "0"), 148, "ascii");
  raw[154] = 0;
  raw[155] = 0x20;
  return gzipSync(raw);
}

interface MetadataOptions {
  readonly name?: string;
  readonly versions?: Readonly<Record<string, { readonly tarball?: string; readonly integrity?: string; readonly extra?: Record<string, unknown> }>>;
  readonly tags?: Readonly<Record<string, string>>;
}

function metadata(options: MetadataOptions): Buffer {
  const name = options.name ?? "safe-plugin";
  const versions = options.versions ?? {
    "1.0.0": { tarball: "https://registry.npmjs.org/safe-plugin/-/safe-plugin-1.0.0.tgz", integrity: integrity(Buffer.from("one")) },
  };
  return Buffer.from(JSON.stringify({
    name,
    "dist-tags": options.tags ?? { latest: Object.keys(versions).at(-1) },
    versions: Object.fromEntries(Object.entries(versions).map(([version, item]) => [version, {
      name,
      version,
      ...(item.extra ?? {}),
      dist: { tarball: item.tarball, integrity: item.integrity },
    }])),
  }));
}

function connectorFor(metadataBody: Uint8Array, tarballBody?: Uint8Array): HttpConnector {
  return async ({ url }) => ({
    status: 200,
    headers: {},
    body: url.pathname.endsWith(".tgz") ? Uint8Array.from(tarballBody ?? new Uint8Array()) : Uint8Array.from(metadataBody),
  });
}

const source = (version?: string) => ({
  kind: "npm" as const,
  package: "safe-plugin",
  ...(version === undefined ? {} : { version }),
  registry: "https://registry.npmjs.org" as const,
});

async function packageTarball(version = "1.0.0"): Promise<Buffer> {
  return await tgz([
    { name: "package/", type: "directory" },
    { name: "package/.claude-plugin/", type: "directory" },
    { name: "package/.claude-plugin/plugin.json", body: "{}" },
    { name: "package/package.json", body: JSON.stringify({ name: "safe-plugin", version }) },
    { name: "package/index.js", body: "export default 1" },
  ]);
}

describe("public npm plugin acquisition", () => {
  it("resolves tags, ranges, exact versions, and prereleases to exact published evidence", async () => {
    const archive = await packageTarball();
    const body = metadata({
      tags: { latest: "1.1.0", next: "2.0.0-beta.2" },
      versions: {
        "1.0.0": { tarball: "https://registry.npmjs.org/safe-plugin/-/1.0.0.tgz", integrity: integrity(archive) },
        "1.1.0": { tarball: "https://registry.npmjs.org/safe-plugin/-/1.1.0.tgz", integrity: integrity(archive) },
        "2.0.0-beta.1": { tarball: "https://registry.npmjs.org/safe-plugin/-/2.0.0-beta.1.tgz", integrity: integrity(archive) },
        "2.0.0-beta.2": { tarball: "https://registry.npmjs.org/safe-plugin/-/2.0.0-beta.2.tgz", integrity: integrity(archive) },
      },
    });
    for (const [selector, expected] of [
      [undefined, "1.1.0"], ["latest", "1.1.0"], ["next", "2.0.0-beta.2"], ["1.0.0", "1.0.0"],
      ["^1.0.0", "1.1.0"], ["^2.0.0-0", "2.0.0-beta.2"],
    ] as const) {
      const result = await resolveNpmPluginSource(source(selector), { resolver, connector: connectorFor(body) });
      expect(result).toMatchObject({
        ok: true,
        value: { package: "safe-plugin", requestedSelector: selector ?? "latest", version: expected, registryOrigin: "https://registry.npmjs.org", packageRoot: "package/" },
      });
    }
    const stableRange = await resolveNpmPluginSource(source("*"), { resolver, connector: connectorFor(body) });
    expect(stableRange).toMatchObject({ ok: true, value: { version: "1.1.0" } });
  });

  it("verifies SHA-512, strips only package/, materializes static bundled/bin/script declarations, and issues refined evidence", async () => {
    const canary = path.join(os.tmpdir(), `picc-npm-script-${process.pid}-${Date.now()}`);
    await fs.rm(canary, { force: true });
    const archive = await tgz([
      { name: "package/", type: "directory" },
      { name: "package/.claude-plugin/", type: "directory" },
      { name: "package/.claude-plugin/plugin.json", body: "{}" },
      { name: "package/package.json", body: JSON.stringify({
        name: "safe-plugin", version: "1.2.3",
        scripts: Object.fromEntries(["preinstall", "install", "postinstall", "prepare", "prepack"].map((name) => [name, `node -e \"require('fs').writeFileSync('${canary.replaceAll("\\", "\\\\")}','${name}')\"`])),
        bin: { canary: "bin/canary.js" }, bundledDependencies: ["bundled"],
      }) },
      { name: "package/bin/", type: "directory" },
      { name: "package/bin/canary.js", body: `require('fs').writeFileSync(${JSON.stringify(canary)}, 'bin')`, mode: 0o755 },
      { name: "package/node_modules/", type: "directory" },
      { name: "package/node_modules/bundled/", type: "directory" },
      { name: "package/node_modules/bundled/index.js", body: `require('fs').writeFileSync(${JSON.stringify(canary)}, 'bundled')` },
    ]);
    const body = metadata({ versions: {
      "1.2.3": { tarball: "https://registry.npmjs.org/safe-plugin/-/safe-plugin-1.2.3.tgz", integrity: integrity(archive) },
    }, tags: { latest: "1.2.3" } });
    const preview = await resolveNpmPluginSource(source("^1.0.0"), { resolver, connector: connectorFor(body) });
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    const acquired = await acquireResolvedNpmPlugin(preview.value, { store: await store(), resolver, connector: connectorFor(body, archive) });
    expect(acquired).toMatchObject({
      ok: true,
      value: {
        kind: "npm-plugin-acquisition", package: "safe-plugin", requestedSelector: "^1.0.0", version: "1.2.3",
        registryOrigin: "https://registry.npmjs.org", integrity: integrity(archive),
        provenance: { adapter: "public-npm-tgz", selectedRoot: { requested: "package/", path: "", usedSingleWrapper: true } },
      },
    });
    expect(acquired.ok && isNpmPluginAcquisitionEvidence(acquired.value)).toBe(true);
    if (acquired.ok) {
      expect(acquired.value.artifactDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(acquired.value.treeDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(acquired.value.rootDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(await fs.readFile(path.join(acquired.value.materialized.pluginRoot, "package.json"), "utf8")).toContain("preinstall");
      expect(await fs.stat(path.join(acquired.value.materialized.pluginRoot, "node_modules", "bundled", "index.js"))).toBeDefined();
      const binPath = path.join(acquired.value.materialized.pluginRoot, "bin", "canary.js");
      expect(await fs.readFile(binPath, "utf8")).toContain("writeFileSync");
      if (process.platform !== "win32") expect((await fs.stat(binPath)).mode & 0o111).not.toBe(0);
    }
    await expect(fs.stat(canary)).rejects.toMatchObject({ code: "ENOENT" });
    let reuseCalls = 0;
    expect(await acquireResolvedNpmPlugin(preview.value, { store: await store(), resolver, connector: async (request) => { reuseCalls += 1; return await connectorFor(body, archive)(request); } }))
      .toMatchObject({ ok: false, error: { code: "unsafe-source" } });
    expect(reuseCalls).toBe(0);
  });

  it("classifies malformed metadata, unpublished selectors, integrity, and unsafe sources truthfully", async () => {
    const archive = await packageTarball();
    const validVersion = {
      name: "safe-plugin", version: "1.0.0",
      dist: { tarball: "https://registry.npmjs.org/x.tgz", integrity: integrity(archive) },
    };
    const malformed = [
      Buffer.from("not json"),
      Buffer.from(JSON.stringify({ name: "safe-plugin", "dist-tags": {} })),
      Buffer.from(JSON.stringify({ name: "safe-plugin", versions: {}, "dist-tags": {} })),
      Buffer.from(JSON.stringify({ name: "safe-plugin", versions: [], "dist-tags": {} })),
      Buffer.from(JSON.stringify({ name: "safe-plugin", versions: { nope: validVersion }, "dist-tags": {} })),
      Buffer.from(JSON.stringify({ name: "safe-plugin", versions: { "1.0.0": "bad" }, "dist-tags": {} })),
      Buffer.from(JSON.stringify({ name: "safe-plugin", versions: { "1.0.0": { ...validVersion, name: "other" } }, "dist-tags": {} })),
      Buffer.from(JSON.stringify({ name: "safe-plugin", versions: { "1.0.0": { ...validVersion, version: "1.0.1" } }, "dist-tags": {} })),
      Buffer.from(JSON.stringify({ name: "safe-plugin", versions: { "1.0.0": { name: "safe-plugin", version: "1.0.0" } }, "dist-tags": { latest: "1.0.0" } })),
      Buffer.from(JSON.stringify({ name: "safe-plugin", versions: { "1.0.0": { name: "safe-plugin", version: "1.0.0", dist: "bad" } }, "dist-tags": { latest: "1.0.0" } })),
      Buffer.from(JSON.stringify({ name: "safe-plugin", versions: { "1.0.0": validVersion }, "dist-tags": { latest: "2.0.0" } })),
      Buffer.from(JSON.stringify({ name: "safe-plugin", versions: { "1.0.0": validVersion }, "dist-tags": { latest: 1 } })),
    ];
    for (const body of malformed) {
      expect(await resolveNpmPluginSource(source(), { resolver, connector: connectorFor(body) }))
        .toMatchObject({ ok: false, error: { code: "invalid-catalog" } });
    }

    const body = metadata({ versions: { "1.0.0": { tarball: "https://registry.npmjs.org/x.tgz", integrity: integrity(archive) } } });
    expect(await resolveNpmPluginSource(source("missing"), { resolver, connector: connectorFor(body) }))
      .toMatchObject({ ok: false, error: { code: "not-found", message: expect.stringContaining("available version or tag") } });

    const canonicalZeroDigest = Buffer.alloc(64).toString("base64");
    const nonCanonicalSha512 = `sha512-${canonicalZeroDigest.slice(0, -3)}B==`;
    for (const badIntegrity of [undefined, `sha1-${Buffer.alloc(20).toString("base64")}`, `${integrity(archive)} ${integrity(archive)}`, "sha512-malformed", nonCanonicalSha512]) {
      const bad = metadata({ versions: { "1.0.0": { tarball: "https://registry.npmjs.org/x.tgz", integrity: badIntegrity } } });
      expect(await resolveNpmPluginSource(source(), { resolver, connector: connectorFor(bad) }))
        .toMatchObject({ ok: false, error: { code: "integrity", message: expect.stringContaining("safe-plugin@1.0.0") } });
    }
    for (const tarball of ["https://user:token@registry.npmjs.org/x.tgz", "https://cdn.example.org/x.tgz"]) {
      const unsafe = metadata({ versions: { "1.0.0": { tarball, integrity: integrity(archive) } } });
      expect(await resolveNpmPluginSource(source(), { resolver, connector: connectorFor(unsafe) }))
        .toMatchObject({ ok: false, error: { code: "unsafe-source", message: expect.stringContaining("public https://registry.npmjs.org") } });
    }

    let customCalls = 0;
    const custom = { kind: "npm", package: "safe-plugin", registry: "https://private.example.org" };
    const customResult = await resolveNpmPluginSource(custom, { resolver, connector: async () => { customCalls += 1; throw new Error("token-canary"); } });
    expect(customResult).toMatchObject({ ok: false, error: { code: "unsafe-source", message: expect.stringContaining("public https://registry.npmjs.org") } });
    expect(customCalls).toBe(0);

    const secret = "credential-token-canary";
    const failed = await resolveNpmPluginSource(source(), { resolver, connector: async () => { throw new Error(secret); } });
    expect(failed).toMatchObject({ ok: false, error: { code: "network-failure" } });
    expect(JSON.stringify(failed)).not.toContain(secret);
  });

  it("rejects metadata and tarball redirects after one connector call", async () => {
    const archive = await packageTarball();
    const body = metadata({ versions: { "1.0.0": { tarball: "https://registry.npmjs.org/x.tgz", integrity: integrity(archive) } } });
    let metadataCalls = 0;
    const redirectedMetadata = await resolveNpmPluginSource(source(), {
      resolver,
      connector: async () => ++metadataCalls === 1
        ? { status: 302, headers: { location: "https://registry.npmjs.org/other" }, body: new Uint8Array() }
        : { status: 200, headers: Object.freeze({}) as Readonly<Record<string, string>>, body },
    });
    expect(redirectedMetadata).toMatchObject({ ok: false, error: { code: "unsafe-source", message: expect.stringContaining("redirects are unsupported") } });
    expect(metadataCalls).toBe(1);

    const preview = await resolveNpmPluginSource(source(), { resolver, connector: connectorFor(body) });
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    let tarballCalls = 0;
    const redirectedTarball = await acquireResolvedNpmPlugin(preview.value, {
      store: await store(), resolver,
      connector: async () => ++tarballCalls === 1
        ? { status: 302, headers: { location: "https://registry.npmjs.org/other.tgz" }, body: new Uint8Array() }
        : { status: 200, headers: Object.freeze({}) as Readonly<Record<string, string>>, body: archive },
    });
    expect(redirectedTarball).toMatchObject({
      ok: false,
      error: { code: "unsafe-source", message: expect.stringMatching(/redirects are unsupported.*Nothing was installed.*preview is consumed/) },
    });
    expect(tarballCalls).toBe(1);

    const networkPreview = await resolveNpmPluginSource(source(), { resolver, connector: connectorFor(body) });
    expect(networkPreview.ok).toBe(true);
    if (!networkPreview.ok) return;
    const networkFailure = await acquireResolvedNpmPlugin(networkPreview.value, {
      store: await store(), resolver, connector: async () => { throw new Error("credential-canary"); },
    });
    expect(networkFailure).toMatchObject({
      ok: false,
      error: { code: "network-failure", message: expect.stringMatching(/Nothing was installed.*resolve a new exact-version preview/) },
    });
    expect(JSON.stringify(networkFailure)).not.toContain("credential-canary");
  });

  it("consumes previews after integrity failures without replay I/O", async () => {
    const archive = await packageTarball();
    const body = metadata({ versions: { "1.0.0": { tarball: "https://registry.npmjs.org/x.tgz", integrity: integrity(archive) } } });
    const preview = await resolveNpmPluginSource(source(), { resolver, connector: connectorFor(body) });
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    expect(await acquireResolvedNpmPlugin(preview.value, { store: await store(), resolver, connector: connectorFor(body, Buffer.from("changed")) }))
      .toMatchObject({ ok: false, error: { code: "integrity", message: expect.stringContaining("safe-plugin@1.0.0") } });
    let replayCalls = 0;
    expect(await acquireResolvedNpmPlugin(preview.value, { store: await store(), resolver, connector: async () => { replayCalls += 1; throw new Error("no replay"); } }))
      .toMatchObject({ ok: false, error: { code: "unsafe-source" } });
    expect(replayCalls).toBe(0);
  });

  it("consumes previews after integrity-matching malformed archives without replay I/O", async () => {
    const malformedArchive = Buffer.from("not a gzip-compressed npm tarball");
    const body = metadata({ versions: {
      "1.0.0": { tarball: "https://registry.npmjs.org/x.tgz", integrity: integrity(malformedArchive) },
    } });
    const preview = await resolveNpmPluginSource(source(), { resolver, connector: connectorFor(body) });
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    expect(await acquireResolvedNpmPlugin(preview.value, { store: await store(), resolver, connector: connectorFor(body, malformedArchive) }))
      .toMatchObject({ ok: false, error: { code: "invalid-archive" } });
    let replayCalls = 0;
    expect(await acquireResolvedNpmPlugin(preview.value, { store: await store(), resolver, connector: async () => { replayCalls += 1; throw new Error("no replay"); } }))
      .toMatchObject({ ok: false, error: { code: "unsafe-source" } });
    expect(replayCalls).toBe(0);
  });

  it("rejects unsafe roots, nonzero directories, links, devices, FIFOs, and special entries", async () => {
    for (const archive of [
      await tgz([{ name: "package/index.js", body: "ok" }, { name: "sibling", body: "no" }]),
      await tgz([{ name: "wrapper/package/index.js", body: "no" }]),
      await malformedDirectory("package/"),
      await malformedDirectory("package/nonzero/"),
      await tgz([{ name: "package/index.js", body: "ok" }, { name: "package/link", type: "symlink", linkname: "index.js" }]),
      await tgz([{ name: "package/index.js", body: "ok" }, { name: "package/hardlink", type: "link", linkname: "package/index.js" }]),
      await tgz([{ name: "package/index.js", body: "ok" }, { name: "package/pipe", type: "fifo" }]),
      await tgz([{ name: "package/index.js", body: "ok" }, { name: "package/char", type: "character-device" }]),
      await tgz([{ name: "package/index.js", body: "ok" }, { name: "package/block", type: "block-device" }]),
      await tgz([{ name: "package/index.js", body: "ok" }, { name: "package/special", type: "contiguous-file" }]),
      await tgz([{ name: "package/Index.js", body: "a" }, { name: "package/index.js", body: "b" }]),
    ]) {
      expect(await parseNpmPackageTree(archive)).toMatchObject({ ok: false, error: { code: "invalid-archive" } });
    }
  });

  it("bounds every tar header and all decompressed bytes including trailing data", async () => {
    const tooManyHeaders = await tgz(Array.from({ length: 10_002 }, (_, index) => ({ name: `package/d${index}/`, type: "directory" as const })));
    expect(await parseNpmPackageTree(tooManyHeaders)).toMatchObject({ ok: false, error: { code: "limit-exceeded" } });

    const archive = await packageTarball();
    const excessiveTrailing = gzipSync(Buffer.concat([gunzipSync(archive), Buffer.alloc(28 * 1024 * 1024)]));
    expect(await parseNpmPackageTree(excessiveTrailing)).toMatchObject({ ok: false, error: { code: "limit-exceeded" } });
  });

  it("requires exact bounded root package identity and consumes failed previews", async () => {
    for (const packageJson of [undefined, "not json", JSON.stringify({ name: "other", version: "1.0.0" }), JSON.stringify({ name: "safe-plugin", version: "1.0.1" })]) {
      const entries: TarEntry[] = [
        { name: "package/", type: "directory" },
        { name: "package/index.js", body: "ok" },
        ...(packageJson === undefined ? [] : [{ name: "package/package.json", body: packageJson }]),
      ];
      const archive = await tgz(entries);
      const body = metadata({ versions: { "1.0.0": { tarball: "https://registry.npmjs.org/x.tgz", integrity: integrity(archive) } } });
      const preview = await resolveNpmPluginSource(source(), { resolver, connector: connectorFor(body) });
      expect(preview.ok).toBe(true);
      if (!preview.ok) continue;
      expect(await acquireResolvedNpmPlugin(preview.value, { store: await store(), resolver, connector: connectorFor(body, archive) }))
        .toMatchObject({ ok: false, error: { code: "invalid-archive", message: expect.stringContaining("safe-plugin@1.0.0") } });
      let replayCalls = 0;
      expect(await acquireResolvedNpmPlugin(preview.value, { store: await store(), resolver, connector: async () => { replayCalls += 1; throw new Error("no replay"); } }))
        .toMatchObject({ ok: false, error: { code: "unsafe-source" } });
      expect(replayCalls).toBe(0);
    }
  });

  it("discards staging and issues no evidence when cancelled immediately after materialization", async () => {
    const archive = await packageTarball();
    const body = metadata({ versions: { "1.0.0": { tarball: "https://registry.npmjs.org/x.tgz", integrity: integrity(archive) } } });
    const preview = await resolveNpmPluginSource(source(), { resolver, connector: connectorFor(body) });
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    const controller = new AbortController();
    const lifecycleStore = await store();
    const witness = issueNpmPostMaterializationWitnessForTest(() => controller.abort());
    const result = await acquireResolvedNpmPlugin(preview.value, {
      store: lifecycleStore, signal: controller.signal, resolver, connector: connectorFor(body, archive), postMaterializationWitness: witness,
    });
    expect(result).toMatchObject({ ok: false, error: { code: "cancelled" } });
    expect(isNpmPluginAcquisitionEvidence(result)).toBe(false);
    expect(await fs.readdir(lifecycleStore.stagingRoot)).toEqual([]);
    let replayCalls = 0;
    expect(await acquireResolvedNpmPlugin(preview.value, { store: lifecycleStore, resolver, connector: async () => { replayCalls += 1; throw new Error("no replay"); } }))
      .toMatchObject({ ok: false, error: { code: "unsafe-source" } });
    expect(replayCalls).toBe(0);
  });

  it("honors cancellation without network or evidence issuance", async () => {
    const controller = new AbortController();
    controller.abort();
    let calls = 0;
    const result = await resolveNpmPluginSource(source(), {
      signal: controller.signal,
      resolver,
      connector: async () => { calls += 1; throw new Error("must not run"); },
    });
    expect(result).toMatchObject({ ok: false, error: { code: "cancelled" } });
    expect(calls).toBe(0);
    expect(await parseNpmPackageTree(await packageTarball(), controller.signal))
      .toMatchObject({ ok: false, error: { code: "cancelled" } });

    const archive = await packageTarball();
    const body = metadata({ versions: {
      "1.0.0": { tarball: "https://registry.npmjs.org/safe-plugin/-/safe-plugin-1.0.0.tgz", integrity: integrity(archive) },
    } });
    const preview = await resolveNpmPluginSource(source(), { resolver, connector: connectorFor(body) });
    expect(preview.ok).toBe(true);
    if (preview.ok) {
      let acquisitionCalls = 0;
      expect(await acquireResolvedNpmPlugin(preview.value, {
        store: await store(), signal: controller.signal, resolver,
        connector: async () => { acquisitionCalls += 1; throw new Error("must not run"); },
      })).toMatchObject({ ok: false, error: { code: "cancelled" } });
      expect(acquisitionCalls).toBe(0);
    }
  });
});

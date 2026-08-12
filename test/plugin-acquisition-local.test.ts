import fs from "node:fs";
import os from "node:os";
import net from "node:net";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { acquireLocalMarketplaceSnapshot } from "../src/plugin-lifecycle/acquisition/local.js";
import { createLifecycleLocations } from "../src/plugin-lifecycle/locations.js";
import { createMarketplaceGeneration, acquireMarketplaceRelativePlugin, issueMarketplaceGenerationFromOwnedAdmission } from "../src/plugin-lifecycle/marketplace-generation.js";
import { establishOwnedStateStore, type OwnedStateStore } from "../src/plugin-lifecycle/state-store.js";
import { isPluginAcquisitionEvidence, type MarketplaceSnapshotEvidence } from "../src/plugin-lifecycle/acquisition/common.js";

function probeNativeLinks(): { readonly directoryAlias: boolean; readonly hardlink: boolean } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "picc-acquire-link-probe-"));
  try {
    const directory = path.join(root, "directory"); fs.mkdirSync(directory);
    let directoryAlias = false; let hardlink = false;
    try { const alias = path.join(root, "alias"); fs.symlinkSync(directory, alias, process.platform === "win32" ? "junction" : "dir"); directoryAlias = fs.lstatSync(alias).isSymbolicLink(); } catch {}
    const source = path.join(root, "source"); fs.writeFileSync(source, "x");
    try { fs.linkSync(source, path.join(root, "hardlink")); hardlink = fs.statSync(source).nlink > 1; } catch {}
    return { directoryAlias, hardlink };
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}
const nativeLinks = probeNativeLinks();
const LOCAL_NOT_FOUND = { ok: false, error: { code: "not-found", message: "The local marketplace source was not found" } } as const;
const LOCAL_CATALOG_NOT_FOUND = { ok: false, error: { code: "not-found", message: "The required local marketplace catalog was not found; add a catalog before retrying" } } as const;
const LOCAL_UNREADABLE = { ok: false, error: { code: "unreadable", message: "The local marketplace source was unreadable" } } as const;
const LOCAL_CHANGED = { ok: false, error: { code: "source-changed", message: "The local marketplace source changed during snapshotting" } } as const;
const LOCAL_LIMIT = { ok: false, error: { code: "limit-exceeded", message: "The local marketplace source exceeds snapshot limits" } } as const;
const roots: string[] = [];
function temporaryRoot(): string {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "picc-acquire-local-")));
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

function writeCatalog(root: string, relative = path.join(".claude-plugin", "marketplace.json")): string {
  const catalog = path.join(root, relative);
  fs.mkdirSync(path.dirname(catalog), { recursive: true });
  fs.writeFileSync(catalog, JSON.stringify({
    name: "local",
    metadata: { pluginRoot: "./runtime" },
    plugins: [{ name: "tool", source: "plugins/tool" }],
  }));
  return catalog;
}

function writePlugin(root: string): void {
  const plugin = path.join(root, "runtime", "plugins", "tool");
  fs.mkdirSync(path.join(plugin, ".claude-plugin"), { recursive: true });
  fs.writeFileSync(path.join(plugin, ".claude-plugin", "plugin.json"), "{}");
  fs.writeFileSync(path.join(plugin, "payload.txt"), "snapshot-one");
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("local marketplace acquisition", () => {
  it("snapshots a directory immutably and binds relative content to its exact generation", async () => {
    const root = temporaryRoot();
    const marketplace = path.join(root, "marketplace");
    writeCatalog(marketplace);
    writePlugin(marketplace);
    const store = await ownedStore(root);
    const result = await acquireLocalMarketplaceSnapshot(
      { kind: "local-directory", path: marketplace },
      { store },
    );
    expect(result.ok).toBe(true);
    expect(issueMarketplaceGenerationFromOwnedAdmission(Object.freeze({}) as never)).toMatchObject({ ok: false, error: { code: "unsafe-source" } });
    if (!result.ok) return;
    fs.writeFileSync(path.join(marketplace, "runtime", "plugins", "tool", "payload.txt"), "changed-source");
    fs.writeFileSync(path.join(marketplace, ".claude-plugin", "marketplace.json"), "{}");

    const generation = createMarketplaceGeneration(result.value);
    expect(generation).toMatchObject({ ok: true, value: { snapshotId: result.value.snapshotId, catalogDigest: result.value.catalogDigest } });
    if (!generation.ok) return;
    const plugin = await acquireMarketplaceRelativePlugin(
      generation.value,
      "tool@local",
      { kind: "relative", path: "plugins/tool", pluginRoot: "runtime" },
      { store },
    );
    expect(plugin.ok).toBe(true);
    if (!plugin.ok) return;
    expect(fs.readFileSync(path.join(plugin.value.materialized.pluginRoot, "payload.txt"), "utf8")).toBe("snapshot-one");
    expect(isPluginAcquisitionEvidence(plugin.value)).toBe(true);
    expect(plugin.value).toMatchObject({
      requestedPluginId: "tool@local",
      source: { kind: "relative", path: "plugins/tool", pluginRoot: "runtime" },
      artifactDigest: plugin.value.treeDigest,
      provenance: {
        adapter: "marketplace-relative-tree", marketplaceSnapshotId: result.value.snapshotId,
        catalogDigest: result.value.catalogDigest, treeDigest: plugin.value.treeDigest,
        rootDigest: plugin.value.rootDigest,
        reviewed: { kind: "local-path" },
        selectedRoot: { requested: "relative-subtree", path: "runtime/plugins/tool", usedSingleWrapper: false },
      },
    });
    expect(plugin.value.rootDigest).not.toBe(plugin.value.treeDigest);
    expect((await acquireMarketplaceRelativePlugin(
      generation.value,
      "tool@local",
      { kind: "relative", path: "plugins", pluginRoot: "runtime" },
      { store },
    )).ok).toBe(false);
    expect((await acquireMarketplaceRelativePlugin(generation.value, "other@local", { kind: "relative", path: "plugins/tool", pluginRoot: "runtime" }, { store })).ok).toBe(false);
    expect((await acquireMarketplaceRelativePlugin(generation.value, "tool@other", { kind: "relative", path: "plugins/tool", pluginRoot: "runtime" }, { store })).ok).toBe(false);
    for (const invalidIdentity of ["Tool@local", "tool@Local", "tool.name@local", "tool_name@local", "con@local", "tool@local.name", "tool@local_name", "tool@con", `${"a".repeat(257)}@local`, `tool@${"a".repeat(257)}`]) {
      expect((await acquireMarketplaceRelativePlugin(generation.value, invalidIdentity as never, { kind: "relative", path: "plugins/tool", pluginRoot: "runtime" }, { store })).ok).toBe(false);
    }

    const duplicateRoot = temporaryRoot(); const duplicateMarketplace = path.join(duplicateRoot, "marketplace"); const duplicateCatalog = writeCatalog(duplicateMarketplace); writePlugin(duplicateMarketplace);
    const duplicateValue = JSON.parse(fs.readFileSync(duplicateCatalog, "utf8")) as { plugins: unknown[] }; duplicateValue.plugins.push({ name: "tool", source: { source: "archive", url: "https://archive.example.org/tool.zip" } }); fs.writeFileSync(duplicateCatalog, JSON.stringify(duplicateValue));
    const duplicateSnapshot = await acquireLocalMarketplaceSnapshot({ kind: "local-directory", path: duplicateMarketplace }, { store: await ownedStore(duplicateRoot) });
    expect(duplicateSnapshot.ok).toBe(true);
    if (duplicateSnapshot.ok) {
      const duplicateGeneration = createMarketplaceGeneration(duplicateSnapshot.value);
      expect(duplicateGeneration.ok).toBe(true);
      if (duplicateGeneration.ok) expect((await acquireMarketplaceRelativePlugin(duplicateGeneration.value, "tool@local", { kind: "relative", path: "plugins/tool", pluginRoot: "runtime" }, { store })).ok).toBe(false);
    }
  });

  it("snapshots a direct catalog file plus only its declared contained relative subtree", async () => {
    const root = temporaryRoot();
    const parent = path.join(root, "catalog-parent");
    const catalog = writeCatalog(parent, "catalog.json");
    writePlugin(parent);
    fs.writeFileSync(path.join(parent, "unrelated-secret.txt"), "must-not-copy");
    const objectRelative = path.join(parent, "runtime", "plugins", "object-only");
    fs.mkdirSync(objectRelative, { recursive: true });
    fs.writeFileSync(path.join(objectRelative, "payload"), "must-not-copy");
    const parsedCatalog = JSON.parse(fs.readFileSync(catalog, "utf8")) as Record<string, unknown>;
    (parsedCatalog["plugins"] as unknown[]).push({ name: "object-only", source: { source: "relative", path: "plugins/object-only" } });
    fs.writeFileSync(catalog, JSON.stringify(parsedCatalog));
    const store = await ownedStore(root);
    const result = await acquireLocalMarketplaceSnapshot(
      { kind: "local-catalog-file", path: catalog },
      { store },
    );
    expect(result.ok).toBe(true);
    if (!result.ok || result.value.materialized === undefined) return;
    expect(fs.existsSync(path.join(result.value.materialized.stagingDirectory, "catalog.json"))).toBe(true);
    expect(fs.existsSync(path.join(result.value.materialized.stagingDirectory, "runtime", "plugins", "tool", "payload.txt"))).toBe(true);
    expect(fs.existsSync(path.join(result.value.materialized.stagingDirectory, "unrelated-secret.txt"))).toBe(false);
    expect(fs.existsSync(path.join(result.value.materialized.stagingDirectory, "runtime", "plugins", "object-only"))).toBe(false);
  });

  it("rejects lifecycle-storage overlap, forged authority, and pre-cancellation", async () => {
    const root = temporaryRoot();
    const marketplace = path.join(root, "marketplace");
    writeCatalog(marketplace);
    writePlugin(marketplace);
    const store = await ownedStore(root);
    expect(await acquireLocalMarketplaceSnapshot(
      { kind: "local-directory", path: marketplace, canary: "not-evidence" } as never,
      { store },
    )).toMatchObject({ ok: false, error: { code: "unsafe-source" } });
    expect(await acquireLocalMarketplaceSnapshot(
      { kind: "local-directory", path: store.profileRoot }, { store },
    )).toMatchObject({ ok: false, error: { code: "storage-overlap" } });
    expect(await acquireLocalMarketplaceSnapshot(
      { kind: "local-directory", path: root }, { store },
    )).toMatchObject({ ok: false, error: { code: "storage-overlap" } });
    expect(await acquireLocalMarketplaceSnapshot(
      { kind: "local-directory", path: marketplace },
      { store: { ...store } as OwnedStateStore },
    )).toMatchObject({ ok: false, error: { code: "unsafe-source" } });

    const controller = new AbortController();
    controller.abort();
    expect(await acquireLocalMarketplaceSnapshot(
      { kind: "local-directory", path: marketplace },
      { store, signal: controller.signal },
    )).toMatchObject({ ok: false, error: { code: "cancelled" } });
  });

  it.skipIf(!nativeLinks.directoryAlias)("rejects a native directory alias", async () => {
    const root = temporaryRoot(); const marketplace = path.join(root, "marketplace"); writeCatalog(marketplace); writePlugin(marketplace);
    const outside = path.join(root, "outside"); fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, "payload"), "outside");
    fs.symlinkSync(outside, path.join(marketplace, "alias"), process.platform === "win32" ? "junction" : "dir");
    expect(await acquireLocalMarketplaceSnapshot({ kind: "local-directory", path: marketplace }, { store: await ownedStore(root) }))
      .toMatchObject({ ok: false, error: { code: "unsafe-source" } });
  });

  it.skipIf(!nativeLinks.hardlink)("rejects a native hardlink", async () => {
    const root = temporaryRoot(); const marketplace = path.join(root, "marketplace"); writeCatalog(marketplace); writePlugin(marketplace);
    const payload = path.join(marketplace, "runtime", "plugins", "tool", "payload.txt");
    fs.linkSync(payload, path.join(marketplace, "hardlink"));
    expect(await acquireLocalMarketplaceSnapshot({ kind: "local-directory", path: marketplace }, { store: await ownedStore(root) }))
      .toMatchObject({ ok: false, error: { code: "unsafe-source" } });
  });

  it.skipIf(process.platform === "win32")("rejects a native POSIX socket entry without commands", async () => {
    const root = temporaryRoot(); const marketplace = path.join(root, "marketplace"); writeCatalog(marketplace); writePlugin(marketplace);
    const socketPath = path.join(marketplace, "native.sock");
    const server = net.createServer();
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socketPath, resolve); });
    try {
      expect((await acquireLocalMarketplaceSnapshot({ kind: "local-directory", path: marketplace }, { store: await ownedStore(root) })).ok).toBe(false);
    } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
  });

  it("detects identical-byte catalog replacement and directory-membership mutation", async () => {
    const root = temporaryRoot(); const marketplace = path.join(root, "marketplace"); const catalog = writeCatalog(marketplace); writePlugin(marketplace);
    const store = await ownedStore(root); const originalRealpath = fs.promises.realpath.bind(fs.promises); let catalogRealpaths = 0;
    vi.spyOn(fs.promises, "realpath").mockImplementation((async (candidate, options) => {
      if (path.resolve(String(candidate)) === path.resolve(catalog) && ++catalogRealpaths === 2) {
        const bytes = fs.readFileSync(catalog); fs.renameSync(catalog, `${catalog}.old`); fs.writeFileSync(catalog, bytes);
      }
      return await originalRealpath(candidate, options as never);
    }) as typeof fs.promises.realpath);
    expect(await acquireLocalMarketplaceSnapshot({ kind: "local-directory", path: marketplace }, { store }))
      .toMatchObject({ ok: false, error: { code: "source-changed" } });
    vi.restoreAllMocks();

    const secondRoot = temporaryRoot(); const secondMarketplace = path.join(secondRoot, "marketplace"); writeCatalog(secondMarketplace); writePlugin(secondMarketplace);
    const originalOpendir = fs.promises.opendir.bind(fs.promises); let rootOpens = 0;
    vi.spyOn(fs.promises, "opendir").mockImplementation((async (candidate, options) => {
      if (path.resolve(String(candidate)) === path.resolve(secondMarketplace) && ++rootOpens === 2) fs.writeFileSync(path.join(secondMarketplace, "late-entry"), "late");
      return await originalOpendir(candidate, options as never);
    }) as typeof fs.promises.opendir);
    expect(await acquireLocalMarketplaceSnapshot({ kind: "local-directory", path: secondMarketplace }, { store: await ownedStore(secondRoot) }))
      .toMatchObject({ ok: false, error: { code: "source-changed" } });
  });

  it("detects directory-root and direct-catalog-parent identity replacement with identical bytes", async () => {
    const directoryRoot = temporaryRoot(); const marketplace = path.join(directoryRoot, "marketplace"); writeCatalog(marketplace); writePlugin(marketplace);
    const original = fs.promises.lstat.bind(fs.promises); let rootStats = 0;
    vi.spyOn(fs.promises, "lstat").mockImplementation((async (candidate, options) => {
      if (path.resolve(String(candidate)) === path.resolve(marketplace) && ++rootStats === 4) {
        fs.renameSync(marketplace, `${marketplace}.old`); fs.cpSync(`${marketplace}.old`, marketplace, { recursive: true });
      }
      return await original(candidate, options as never);
    }) as typeof fs.promises.lstat);
    expect(await acquireLocalMarketplaceSnapshot({ kind: "local-directory", path: marketplace }, { store: await ownedStore(directoryRoot) }))
      .toMatchObject({ ok: false, error: { code: "source-changed" } });
    vi.restoreAllMocks();

    const fileRoot = temporaryRoot(); const parent = path.join(fileRoot, "catalog-parent"); const catalog = writeCatalog(parent, "catalog.json"); writePlugin(parent);
    const parentOriginal = fs.promises.lstat.bind(fs.promises); let parentStats = 0;
    vi.spyOn(fs.promises, "lstat").mockImplementation((async (candidate, options) => {
      if (path.resolve(String(candidate)) === path.resolve(parent) && ++parentStats === 2) {
        fs.renameSync(parent, `${parent}.old`); fs.cpSync(`${parent}.old`, parent, { recursive: true });
      }
      return await parentOriginal(candidate, options as never);
    }) as typeof fs.promises.lstat);
    expect(await acquireLocalMarketplaceSnapshot({ kind: "local-catalog-file", path: catalog }, { store: await ownedStore(fileRoot) }))
      .toMatchObject({ ok: false, error: { code: "source-changed" } });
  });

  it("accepts exact catalog/file/total byte limits and rejects plus one before evidence", async () => {
    const exactCatalogRoot = temporaryRoot(); const marketplace = path.join(exactCatalogRoot, "marketplace");
    const catalogDocument = '{"plugins":[]}';
    fs.mkdirSync(path.join(marketplace, ".claude-plugin"), { recursive: true });
    fs.writeFileSync(path.join(marketplace, ".claude-plugin", "marketplace.json"), catalogDocument + " ".repeat(1024 * 1024 - catalogDocument.length));
    expect((await acquireLocalMarketplaceSnapshot({ kind: "local-directory", path: marketplace }, { store: await ownedStore(exactCatalogRoot) })).ok).toBe(true);
    fs.appendFileSync(path.join(marketplace, ".claude-plugin", "marketplace.json"), "x");
    expect(await acquireLocalMarketplaceSnapshot({ kind: "local-directory", path: marketplace }, { store: await ownedStore(exactCatalogRoot) }))
      .toEqual(LOCAL_LIMIT);

    const fileRoot = temporaryRoot(); const fileMarketplace = path.join(fileRoot, "marketplace"); writeCatalog(fileMarketplace);
    fs.writeFileSync(path.join(fileMarketplace, "maximum"), Buffer.alloc(8 * 1024 * 1024));
    expect((await acquireLocalMarketplaceSnapshot({ kind: "local-directory", path: fileMarketplace }, { store: await ownedStore(fileRoot) })).ok).toBe(true);
    fs.appendFileSync(path.join(fileMarketplace, "maximum"), "x");
    expect(await acquireLocalMarketplaceSnapshot({ kind: "local-directory", path: fileMarketplace }, { store: await ownedStore(fileRoot) }))
      .toEqual(LOCAL_LIMIT);

    const totalRoot = temporaryRoot(); const totalMarketplace = path.join(totalRoot, "marketplace"); const totalCatalog = writeCatalog(totalMarketplace);
    const catalogBytes = fs.statSync(totalCatalog).size;
    fs.writeFileSync(path.join(totalMarketplace, "first"), Buffer.alloc(8 * 1024 * 1024));
    fs.writeFileSync(path.join(totalMarketplace, "second"), Buffer.alloc(8 * 1024 * 1024 - catalogBytes));
    expect((await acquireLocalMarketplaceSnapshot({ kind: "local-directory", path: totalMarketplace }, { store: await ownedStore(totalRoot) })).ok).toBe(true);
    fs.appendFileSync(path.join(totalMarketplace, "second"), "x");
    expect(await acquireLocalMarketplaceSnapshot({ kind: "local-directory", path: totalMarketplace }, { store: await ownedStore(totalRoot) }))
      .toEqual(LOCAL_LIMIT);
  });

  it("detects a file mutation between its stable read and path revalidation", async () => {
    const root = temporaryRoot();
    const marketplace = path.join(root, "marketplace");
    writeCatalog(marketplace);
    writePlugin(marketplace);
    const payload = path.join(marketplace, "runtime", "plugins", "tool", "payload.txt");
    const original = fs.promises.lstat.bind(fs.promises);
    let payloadStats = 0;
    vi.spyOn(fs.promises, "lstat").mockImplementation((async (candidate, options) => {
      if (path.resolve(String(candidate)) === path.resolve(payload)) {
        payloadStats += 1;
        if (payloadStats === 3) fs.writeFileSync(payload, "mutated-during-read");
      }
      return await original(candidate, options as never);
    }) as typeof fs.promises.lstat);
    expect((await acquireLocalMarketplaceSnapshot(
      { kind: "local-directory", path: marketplace },
      { store: await ownedStore(root) },
    )).ok).toBe(false);
  });

  it("discards exact staging on post-materialization cancellation and preserves identity-changed replacement", async () => {
    for (const replace of [false, true]) {
      const root = temporaryRoot();
      const marketplace = path.join(root, "marketplace"); writeCatalog(marketplace); writePlugin(marketplace);
      const store = await ownedStore(root);
      const controller = new AbortController();
      const original = fs.promises.lstat.bind(fs.promises);
      let stagingPath = ""; let stagingStats = 0;
      vi.spyOn(fs.promises, "lstat").mockImplementation((async (candidate, options) => {
        const candidatePath = String(candidate);
        if (path.basename(candidatePath).startsWith(".picc-staging-")) {
          stagingPath = candidatePath;
          stagingStats += 1;
          if (stagingStats === 3) {
            controller.abort();
            if (replace) {
              fs.renameSync(stagingPath, `${stagingPath}.old`);
              fs.mkdirSync(stagingPath);
              fs.writeFileSync(path.join(stagingPath, "replacement"), "untouched");
            }
          }
        }
        return await original(candidate, options as never);
      }) as typeof fs.promises.lstat);
      const result = await acquireLocalMarketplaceSnapshot({ kind: "local-directory", path: marketplace }, { store, signal: controller.signal });
      expect(result).toMatchObject({ ok: false, error: { code: "cancelled" } });
      expect(stagingPath).not.toBe("");
      if (replace) expect(fs.readFileSync(path.join(stagingPath, "replacement"), "utf8")).toBe("untouched");
      else expect(fs.existsSync(stagingPath)).toBe(false);
      vi.restoreAllMocks();
    }
  });

  it("rejects route-invalid but filesystem-resolvable local descriptors before staging", async () => {
    const root = temporaryRoot(); const marketplace = path.join(root, "marketplace"); writeCatalog(marketplace); writePlugin(marketplace);
    const store = await ownedStore(root);
    const before = fs.readdirSync(store.stagingRoot);
    const invalid = [
      `${root}${path.sep}parent${path.sep}..${path.sep}marketplace`,
      `${marketplace}${path.sep}.`,
      ...(process.platform === "win32" ? [] : [`${root}${path.sep}marketplace `, `${root}${path.sep}CON`]),
    ];
    if (process.platform !== "win32") {
      fs.cpSync(marketplace, `${root}${path.sep}marketplace `, { recursive: true });
      fs.cpSync(marketplace, `${root}${path.sep}CON`, { recursive: true });
    }
    for (const candidate of invalid) {
      expect(await acquireLocalMarketplaceSnapshot({ kind: "local-directory", path: candidate }, { store }))
        .toMatchObject({ ok: false, error: { code: "unsafe-source" } });
    }
    expect(fs.readdirSync(store.stagingRoot)).toEqual(before);
  });

  it("reports an initially absent required directory catalog with catalog-specific guidance", async () => {
    const root = temporaryRoot();
    const marketplace = path.join(root, "marketplace");
    fs.mkdirSync(marketplace);
    const result = await acquireLocalMarketplaceSnapshot(
      { kind: "local-directory", path: marketplace },
      { store: await ownedStore(root) },
    );
    expect(result).toEqual(LOCAL_CATALOG_NOT_FOUND);
    expect(JSON.stringify(result)).not.toContain(marketplace);
  });

  it("classifies catalog disappearance between stable-file binding and open as source-changed", async () => {
    const root = temporaryRoot();
    const marketplace = path.join(root, "marketplace");
    const catalog = writeCatalog(marketplace);
    writePlugin(marketplace);
    const originalOpen = fs.promises.open.bind(fs.promises);
    let catalogOpens = 0;
    vi.spyOn(fs.promises, "open").mockImplementation((async (candidate, flags, mode) => {
      if (path.resolve(String(candidate)) === path.resolve(catalog)) {
        catalogOpens += 1;
        throw Object.assign(new Error("gone after binding"), { code: "ENOENT" });
      }
      return await originalOpen(candidate, flags, mode);
    }) as typeof fs.promises.open);
    expect(await acquireLocalMarketplaceSnapshot(
      { kind: "local-directory", path: marketplace },
      { store: await ownedStore(root) },
    )).toEqual(LOCAL_CHANGED);
    expect(catalogOpens).toBe(1);
  });

  it("maps initial absence, access failures, and post-binding disappearance actionably without paths", async () => {
    const root = temporaryRoot(); const store = await ownedStore(root); const missing = path.join(root, "secret-missing");
    const notFound = await acquireLocalMarketplaceSnapshot({ kind: "local-directory", path: missing }, { store });
    expect(notFound).toEqual(LOCAL_NOT_FOUND);
    expect(JSON.stringify(notFound)).not.toContain(missing);
    const marketplace = path.join(root, "invalid-marketplace"); fs.mkdirSync(path.join(marketplace, ".claude-plugin"), { recursive: true });
    fs.writeFileSync(path.join(marketplace, ".claude-plugin", "marketplace.json"), "not-json");
    expect(await acquireLocalMarketplaceSnapshot({ kind: "local-directory", path: marketplace }, { store }))
      .toMatchObject({ ok: false, error: { code: "invalid-catalog" } });

    const accessRoot = temporaryRoot(); const accessMarketplace = path.join(accessRoot, "marketplace"); writeCatalog(accessMarketplace); writePlugin(accessMarketplace);
    const originalOpendir = fs.promises.opendir.bind(fs.promises);
    vi.spyOn(fs.promises, "opendir").mockImplementation((async (candidate, options) => {
      if (path.resolve(String(candidate)) === path.resolve(accessMarketplace)) throw Object.assign(new Error("denied"), { code: "EACCES" });
      return await originalOpendir(candidate, options as never);
    }) as typeof fs.promises.opendir);
    expect(await acquireLocalMarketplaceSnapshot({ kind: "local-directory", path: accessMarketplace }, { store: await ownedStore(accessRoot) }))
      .toEqual(LOCAL_UNREADABLE);
    vi.restoreAllMocks();

    const statRoot = temporaryRoot(); const statMarketplace = path.join(statRoot, "marketplace"); writeCatalog(statMarketplace); writePlugin(statMarketplace);
    const statPayload = path.join(statMarketplace, "runtime", "plugins", "tool", "payload.txt");
    const statLstat = fs.promises.lstat.bind(fs.promises);
    vi.spyOn(fs.promises, "lstat").mockImplementation((async (candidate, options) => {
      if (path.resolve(String(candidate)) === path.resolve(statPayload)) throw Object.assign(new Error("denied"), { code: "EACCES" });
      return await statLstat(candidate, options as never);
    }) as typeof fs.promises.lstat);
    expect(await acquireLocalMarketplaceSnapshot({ kind: "local-directory", path: statMarketplace }, { store: await ownedStore(statRoot) }))
      .toEqual(LOCAL_UNREADABLE);
    vi.restoreAllMocks();

    const readRoot = temporaryRoot(); const readMarketplace = path.join(readRoot, "marketplace"); writeCatalog(readMarketplace); writePlugin(readMarketplace);
    const payload = path.join(readMarketplace, "runtime", "plugins", "tool", "payload.txt");
    const originalOpen = fs.promises.open.bind(fs.promises);
    vi.spyOn(fs.promises, "open").mockImplementation((async (candidate, flags, mode) => {
      if (path.resolve(String(candidate)) === path.resolve(payload)) throw Object.assign(new Error("denied"), { code: "EPERM" });
      return await originalOpen(candidate, flags, mode);
    }) as typeof fs.promises.open);
    expect(await acquireLocalMarketplaceSnapshot({ kind: "local-directory", path: readMarketplace }, { store: await ownedStore(readRoot) }))
      .toEqual(LOCAL_UNREADABLE);
    vi.restoreAllMocks();

    const raceRoot = temporaryRoot(); const raceMarketplace = path.join(raceRoot, "marketplace"); writeCatalog(raceMarketplace); writePlugin(raceMarketplace);
    const racePayload = path.join(raceMarketplace, "runtime", "plugins", "tool", "payload.txt");
    const originalLstat = fs.promises.lstat.bind(fs.promises); let payloadStats = 0;
    vi.spyOn(fs.promises, "lstat").mockImplementation((async (candidate, options) => {
      if (path.resolve(String(candidate)) === path.resolve(racePayload) && ++payloadStats === 2) {
        throw Object.assign(new Error("gone"), { code: "ENOENT" });
      }
      return await originalLstat(candidate, options as never);
    }) as typeof fs.promises.lstat);
    expect(await acquireLocalMarketplaceSnapshot({ kind: "local-directory", path: raceMarketplace }, { store: await ownedStore(raceRoot) }))
      .toEqual(LOCAL_CHANGED);
  });

  it.skipIf(process.platform === "win32")("rejects files with no readable mode bits", async () => {
    const root = temporaryRoot();
    const marketplace = path.join(root, "marketplace");
    writeCatalog(marketplace);
    writePlugin(marketplace);
    fs.chmodSync(path.join(marketplace, "runtime", "plugins", "tool", "payload.txt"), 0o000);
    expect(await acquireLocalMarketplaceSnapshot(
      { kind: "local-directory", path: marketplace },
      { store: await ownedStore(root) },
    )).toMatchObject({ ok: false, error: { code: "unreadable" } });
  });

  it("refuses declaration-shaped marketplace evidence", () => {
    expect(createMarketplaceGeneration({
      kind: "marketplace-snapshot",
      source: { kind: "local-directory", path: "/forged" },
      snapshotId: "marketplace-forged",
      catalogDigest: `sha256:${"0".repeat(64)}`,
      provenance: {},
    } as unknown as MarketplaceSnapshotEvidence)).toMatchObject({ ok: false });
  });
});

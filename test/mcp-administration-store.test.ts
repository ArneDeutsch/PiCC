import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createLifecycleLocations,
  createMcpLifecycleLocations,
  OwnedStateStoreNamespace,
  profileLocationKey,
  type LifecycleLocations,
} from "../src/plugin-lifecycle/locations.js";
import { establishOwnedStateStore, revalidateOwnedStateStore, type OwnedStateStore } from "../src/plugin-lifecycle/state-store.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))); });

async function privateHome(prefix = "picc-mcp-store-"): Promise<string> {
  const home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
  roots.push(home);
  if (process.platform !== "win32") await fs.chmod(home, 0o700);
  return home;
}

function platform(): "win32" | "posix" {
  return process.platform === "win32" ? "win32" : "posix";
}

function mcpLocations(home: string, profile = "profile"): LifecycleLocations {
  const result = createMcpLifecycleLocations({ homeDir: home, profilePath: path.join(home, profile), platform: platform() });
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

async function establish(locations: LifecycleLocations, home: string): Promise<OwnedStateStore> {
  const result = await establishOwnedStateStore(locations, home);
  if (!result.ok) throw new Error(result.message);
  return result.value;
}

const storeDirectories = (store: OwnedStateStore): readonly string[] => [
  store.artifactsRoot,
  store.recordsRoot,
  store.stagingRoot,
  store.generationsRoot,
  store.journalsRoot,
  store.receiptsRoot,
  store.locksRoot,
  store.quarantineRoot,
  store.dataRoot,
];

describe("MCP administration transaction store", () => {
  it("uses the exact profile-scoped MCP layout with a complete private directory set", async () => {
    const home = await privateHome();
    const profilePath = path.join(home, "profile");
    const profileKey = profileLocationKey(profilePath, platform());
    if (!profileKey.ok) throw new Error(profileKey.error.message);
    const locations = mcpLocations(home);
    const expectedNamespaceRoot = path.join(home, ".picc", "mcp", "v1");
    const expectedProfileRoot = path.join(expectedNamespaceRoot, "profiles", profileKey.value);
    const expected = (value: string): string => process.platform === "win32" ? value.toLowerCase() : value;

    expect(locations.storeNamespace).toBe(OwnedStateStoreNamespace.Mcp);
    expect(expected(locations.root)).toBe(expected(expectedNamespaceRoot));
    expect(expected(locations.profileRoot)).toBe(expected(expectedProfileRoot));
    expect(locations.profileKey).toBe(profileKey.value);
    expect(expected(locations.dataRoot)).toBe(expected(path.join(expectedProfileRoot, "data")));

    const store = await establish(locations, home);
    expect(expected(store.root)).toBe(expected(expectedProfileRoot));
    expect(expected(store.profileRoot)).toBe(expected(expectedProfileRoot));
    expect(store.profileKey).toBe(profileKey.value);
    expect(await revalidateOwnedStateStore(store)).toEqual({ ok: true, value: undefined });
    expect((await fs.readdir(store.profileRoot)).sort()).toEqual([
      "artifacts", "data", "generations", "journals", "locks", "quarantine", "receipts", "records", "staging",
    ]);
    const completeDirectories = [
      path.join(home, ".picc"),
      path.join(home, ".picc", "mcp"),
      locations.root,
      path.dirname(locations.profileRoot),
      store.profileRoot,
      path.join(store.profileRoot, "artifacts"),
      ...storeDirectories(store),
    ];
    for (const directory of completeDirectories) {
      const stat = await fs.lstat(directory);
      expect(stat.isDirectory()).toBe(true);
      expect(stat.isSymbolicLink()).toBe(false);
      if (process.platform !== "win32") expect(stat.mode & 0o077).toBe(0);
    }
  });

  it("keeps MCP and plugin journals, receipts, and locks independent for the same profile and operation", async () => {
    const home = await privateHome();
    const profilePath = path.join(home, "profile");
    const pluginResult = createLifecycleLocations({ homeDir: home, profilePath, platform: platform() });
    if (!pluginResult.ok) throw new Error(pluginResult.error.message);
    const mcp = await establish(mcpLocations(home), home);
    const plugins = await establish(pluginResult.value, home);

    expect(mcp.profileKey).toBe(plugins.profileKey);
    expect(mcp.profileRoot).not.toBe(plugins.profileRoot);
    for (const key of ["journalsRoot", "receiptsRoot", "locksRoot"] as const) {
      expect(mcp[key]).not.toBe(plugins[key]);
      await fs.writeFile(path.join(mcp[key], "same-operation"), "mcp");
      await fs.writeFile(path.join(plugins[key], "same-operation"), "plugins");
      expect(await fs.readFile(path.join(mcp[key], "same-operation"), "utf8")).toBe("mcp");
      expect(await fs.readFile(path.join(plugins[key], "same-operation"), "utf8")).toBe("plugins");
    }
  });

  it("rejects cross-namespace, mismatched profile, root, data, and trusted-home evidence", async () => {
    const home = await privateHome();
    const otherHome = await privateHome("picc-mcp-other-home-");
    const mcp = mcpLocations(home);
    const pluginResult = createLifecycleLocations({ homeDir: home, profilePath: path.join(home, "profile"), platform: platform() });
    const otherProfile = profileLocationKey(path.join(home, "other-profile"), platform());
    if (!pluginResult.ok || !otherProfile.ok) throw new Error("location fixture failed");

    const rejected: readonly LifecycleLocations[] = [
      { ...mcp, storeNamespace: OwnedStateStoreNamespace.Plugins },
      { ...pluginResult.value, storeNamespace: OwnedStateStoreNamespace.Mcp },
      { ...mcp, profileKey: otherProfile.value },
      { ...mcp, root: path.join(home, ".picc", "arbitrary", "v1") },
      { ...mcp, profileRoot: path.join(mcp.root, "profiles", otherProfile.value) },
      { ...mcp, dataRoot: path.join(mcp.profileRoot, "other-data") },
    ];
    for (const locations of rejected) {
      await expect(establishOwnedStateStore(locations, home)).resolves.toMatchObject({ ok: false, code: "unsafe-store" });
    }
    await expect(establishOwnedStateStore(mcp, otherHome)).resolves.toMatchObject({ ok: false, code: "unsafe-store" });
    await expect(establishOwnedStateStore({ ...mcp, storeNamespace: "arbitrary" as OwnedStateStoreNamespace }, home))
      .resolves.toMatchObject({ ok: false, code: "unsafe-store" });
  });

  it("rejects aliased MCP components and trusted-home aliases", async () => {
    const home = await privateHome();
    const aliasTarget = await privateHome("picc-mcp-alias-target-");
    const namespaceParent = path.join(home, ".picc");
    await fs.mkdir(namespaceParent, { mode: 0o700 });
    const namespacePath = path.join(namespaceParent, "mcp");
    try {
      await fs.symlink(aliasTarget, namespacePath, process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? "";
      if (process.platform === "win32" && ["EPERM", "EACCES", "ENOTSUP"].includes(code)) return;
      throw error;
    }
    await expect(establishOwnedStateStore(mcpLocations(home), home)).resolves.toMatchObject({ ok: false, code: "unsafe-store" });

    if (process.platform !== "win32") {
      const realHome = await privateHome("picc-mcp-real-home-");
      const aliasHome = `${realHome}-alias`;
      roots.push(aliasHome);
      await fs.symlink(realHome, aliasHome, "dir");
      await expect(establishOwnedStateStore(mcpLocations(aliasHome), aliasHome)).resolves.toMatchObject({ ok: false, code: "unsafe-store" });
    }
  });

  it.skipIf(process.platform !== "win32")("rejects Windows namespace and UNC MCP authority", async () => {
    const home = await privateHome();
    const locations = mcpLocations(home);
    await expect(establishOwnedStateStore(locations, String.raw`\\?\C:\unsafe`)).resolves.toMatchObject({ ok: false, code: "unsafe-store" });
    await expect(establishOwnedStateStore({ ...locations, root: String.raw`\\server\share\mcp` }, home)).resolves.toMatchObject({ ok: false, code: "unsafe-store" });
  });
});

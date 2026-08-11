import { describe, expect, it } from "vitest";
import {
  canonicalLocationIdentity,
  checkoutFamilyKeyForScope,
  checkoutFamilyLocationKey,
  createLifecycleLocations,
  lifecycleSettingsTarget,
  pluginDataIdentity,
  pluginDataPath,
  profileLocationKey,
} from "../src/plugin-lifecycle/locations.js";
import {
  ABSENT_DEFAULT,
  SOURCE_MATRIX,
  explicitDefault,
  normalizePortableRelativePath,
  qualifiedPluginIdentity,
  resolveInitialEnablement,
  routeCatalogPluginSource,
  routeMarketplaceSource,
} from "../src/plugin-lifecycle/source-matrix.js";
import {
  LIFECYCLE_OWNERSHIPS,
  MUTABLE_PLUGIN_SCOPES,
  PLUGIN_LIFECYCLE_LIMITS,
} from "../src/plugin-lifecycle/types.js";
import type {
  LifecycleOwnership,
  LifecycleScopeLocation,
  MutablePluginScope,
  PluginDataIdentity,
  QualifiedPluginIdentity,
  Sha256,
} from "../src/plugin-lifecycle/types.js";
import type {
  PluginMarketplaceCatalogSource,
  PluginManifestDefaultEnabledEvidence,
} from "../src/types.js";

const localContext = { marketplaceSourceKind: "local-directory" as const };

function expectRejectedWithout(result: unknown, secret: string): void {
  expect(result).toMatchObject({ ok: false });
  expect(JSON.stringify(result)).not.toContain(secret);
}

describe("executable declaration source matrix", () => {
  it("owns every accepted declaration family, adapter, and root rule", () => {
    expect(SOURCE_MATRIX.map(({ surface, source, adapter, rootRule }) => ({ surface, source, adapter, rootRule }))).toEqual([
      { surface: "marketplace", source: "directory", adapter: "local-directory-snapshot", rootRule: "snapshot-directory-root" },
      { surface: "marketplace", source: "file", adapter: "local-catalog-snapshot", rootRule: "snapshot-catalog-parent" },
      { surface: "marketplace", source: "github", adapter: "anonymous-https-git", rootRule: "repository-root" },
      { surface: "marketplace", source: "git", adapter: "anonymous-https-git", rootRule: "repository-root" },
      { surface: "marketplace", source: "url", adapter: "public-https-catalog", rootRule: "descriptor-has-no-relative-root" },
      { surface: "plugin", source: "relative", adapter: "marketplace-relative-tree", rootRule: "marketplace-generation-relative-subtree" },
      { surface: "plugin", source: "github", adapter: "anonymous-https-git", rootRule: "repository-root" },
      { surface: "plugin", source: "url", adapter: "anonymous-https-git", rootRule: "repository-root" },
      { surface: "plugin", source: "git-subdir", adapter: "anonymous-https-git-subdir", rootRule: "repository-declared-subdirectory" },
      { surface: "plugin", source: "npm", adapter: "public-npm-tgz", rootRule: "npm-package-directory" },
      { surface: "plugin", source: "archive", adapter: "public-https-zip", rootRule: "zip-root-or-single-wrapper" },
    ]);
  });

  it("self-discriminates every matrix parser by declaration surface and source", () => {
    const descriptors = [
      { source: "directory", path: "/catalog" },
      { source: "file", path: "C:\\catalog\\marketplace.json" },
      { source: "github", repo: "owner/catalog" },
      { source: "git", url: "https://git.example.org/catalog.git" },
      { source: "url", url: "https://catalog.example.org/catalog.json" },
      { source: "relative", path: "./plugins/tool" },
      { source: "github", repo: "owner/tool" },
      { source: "url", url: "https://git.example.org/tool.git" },
      { source: "git-subdir", url: "https://git.example.org/tools.git", path: "plugins/tool" },
      { source: "npm", package: "tool" },
      { source: "archive", url: "https://archive.example.org/tool.zip" },
    ] as const;

    SOURCE_MATRIX.forEach((entry, index) => {
      const descriptor = descriptors[index]!;
      const parsed = entry.parse(descriptor, localContext, entry.surface);
      expect(parsed).toMatchObject({ adapter: entry.adapter, rootRule: entry.rootRule });
      expect(entry.parse({ ...descriptor, source: `${descriptor.source}-other` }, localContext, entry.surface)).toBeUndefined();
      expect(entry.parse(descriptor, localContext, entry.surface === "plugin" ? "marketplace" : "plugin")).toBeUndefined();
    });
  });

  it("routes all supported marketplace and catalog-plugin declarations without claiming acquisition evidence", () => {
    const marketplaceDeclarations = [
      { source: "directory", path: "/catalog" },
      { source: "file", path: "C:\\catalog\\marketplace.json" },
      { source: "github", repo: "owner/catalog", ref: "v1" },
      { source: "git", url: "https://git.example.org/catalog.git", ref: "main" },
      { source: "url", url: "https://catalog.example.org/catalog.json" },
    ];
    const pluginDeclarations = [
      "./plugins/tool",
      { source: "github", repo: "owner/tool", ref: "v1", sha: "a".repeat(40) },
      { source: "url", url: "https://git.example.org/tool.git", ref: "main", sha: "b".repeat(40) },
      { source: "git-subdir", url: "https://git.example.org/tools.git", path: "plugins/tool", ref: "main", sha: "c".repeat(40) },
      { source: "npm", package: "@scope/tool", version: "^1.2.3", registry: "https://registry.npmjs.org" },
      { source: "archive", url: "https://archive.example.org/tool.zip", sha256: "d".repeat(64) },
    ];

    for (const declaration of marketplaceDeclarations) {
      const result = routeMarketplaceSource(declaration);
      expect(result.ok).toBe(true);
      if (result.ok) expect(Object.keys(result.value).sort()).toEqual(["adapter", "descriptor", "rootRule"]);
    }
    for (const declaration of pluginDeclarations) {
      const result = routeCatalogPluginSource(declaration, localContext);
      expect(result.ok).toBe(true);
      if (result.ok) expect(Object.keys(result.value).sort()).toEqual(["adapter", "descriptor", "rootRule"]);
    }
  });

  it("preserves replayable accepted descriptors and rejects credentials or sensitive carriers generically", () => {
    const exactUrl = "https://artifacts.example.org:8443/catalog.git";
    expect(routeMarketplaceSource({ source: "git", url: exactUrl })).toMatchObject({
      ok: true,
      value: { descriptor: { kind: "https-git", url: exactUrl } },
    });

    const secret = "secret-canary";
    const rejected = [
      routeMarketplaceSource({ source: "git", url: `https://user:${secret}@artifacts.example.org/catalog.git` }),
      routeMarketplaceSource({ source: "git", url: "https://@artifacts.example.org/catalog.git" }),
      routeMarketplaceSource({ source: "url", url: `https://artifacts.example.org/catalog.json?token=${secret}` }),
      routeMarketplaceSource({ source: "url", url: "https://artifacts.example.org/catalog.json?" }),
      routeMarketplaceSource({ source: "url", url: `https://artifacts.example.org/catalog.json#${secret}` }),
      routeMarketplaceSource({ source: "url", url: "https://artifacts.example.org/catalog.json#" }),
      routeMarketplaceSource({ source: "git", url: "ssh://git@artifacts.example.org/catalog.git" }),
      routeMarketplaceSource({ source: "git", url: "git@artifacts.example.org:catalog.git" }),
      routeMarketplaceSource({ source: "url", url: "http://artifacts.example.org/catalog.json" }),
      routeMarketplaceSource({ source: "url", url: "https://127.0.0.1/catalog.json" }),
      routeMarketplaceSource({ source: "url", url: "https://localhost/catalog.json" }),
      routeCatalogPluginSource({ source: "archive", url: "https://archive.example.org/tool.zip", headers: { Authorization: secret } }, localContext),
    ];
    rejected.forEach((result) => expectRejectedWithout(result, secret));
  });

  it("rejects deferred source families and mutable or private source variants", () => {
    const rejected = [
      routeCatalogPluginSource({ source: "dependencies", packages: ["tool"] }, localContext),
      routeCatalogPluginSource({ source: "github", repo: "owner/tool", branch: "main" }, localContext),
      routeCatalogPluginSource({ source: "npm", package: "tool", registry: "https://registry.example.org" }, localContext),
      routeCatalogPluginSource({ source: "npm", package: "tool", version: "git+https://git.example.org/tool" }, localContext),
      routeCatalogPluginSource({ source: "archive", url: "https://archive.example.org/tool.zip?token=x" }, localContext),
    ];
    expect(rejected.every((result) => !result.ok)).toBe(true);
  });

  it("enforces ./ versus bare-relative grammar and direct-descriptor root restrictions", () => {
    expect(routeCatalogPluginSource({ source: "relative", path: "./plugins/tool" }, localContext)).toMatchObject({
      ok: false,
      error: { code: "unsupported-source" },
    });
    expect(routeCatalogPluginSource({ source: "relative", path: "./plugins/tool", canary: "must-not-copy" }, localContext)).toMatchObject({ ok: false });
    expect(routeCatalogPluginSource("./plugins/tool", localContext)).toMatchObject({
      ok: true,
      value: { descriptor: { kind: "relative", path: "plugins/tool" } },
    });
    expect(routeCatalogPluginSource("plugins/tool", localContext)).toMatchObject({
      ok: false,
      error: { code: "invalid-relative-path" },
    });
    expect(routeCatalogPluginSource("plugins/tool", { ...localContext, metadataPluginRoot: "runtime" })).toMatchObject({
      ok: true,
      value: { descriptor: { kind: "relative", path: "plugins/tool", pluginRoot: "runtime" } },
    });
    expect(routeCatalogPluginSource("./plugins/tool", { marketplaceSourceKind: "https-catalog" })).toMatchObject({
      ok: false,
      error: { code: "relative-source-unavailable" },
    });
  });

  it("accepts archive declarations independently of URL suffix without claiming ZIP-byte evidence", () => {
    for (const url of [
      "https://archive.example.org/download",
      "https://archive.example.org/tool.tar.gz",
      "https://archive.example.org/tool.zip",
    ]) {
      expect(routeCatalogPluginSource({ source: "archive", url }, localContext)).toMatchObject({
        ok: true,
        value: { descriptor: { kind: "https-zip", url } },
      });
    }
  });

  it("uses portable relative paths and rejects UNC or Windows namespace local declarations", () => {
    for (const value of ["plugins/tool", "plugins/a-b_c/file.json"]) {
      expect(normalizePortableRelativePath(value)).toBe(value);
    }
    for (const value of ["../tool", "./tool", "plugins\\tool", "C:/tool", "plugins/CON", "plugins/COM¹", "plugins/trailing. "]) {
      expect(normalizePortableRelativePath(value)).toBeUndefined();
    }
    for (const localPath of ["/catalog", "C:\\catalog"]) {
      expect(routeMarketplaceSource({ source: "directory", path: localPath }).ok).toBe(true);
    }
    for (const localPath of [
      "catalog",
      ".\\catalog",
      "C:catalog",
      "/catalog/CON",
      "\\\\server",
      "\\\\server\\share\\catalog",
      "//server",
      "//server/share/catalog",
      "\\\\?\\C:\\catalog",
      "//?/C:/catalog",
      "\\\\.\\PhysicalDrive0",
      "\\\\?\\GLOBALROOT\\Device\\HarddiskVolume1\\catalog",
      "\\\\.\\GLOBALROOT\\Device\\HarddiskVolume1\\catalog",
      "//./GLOBALROOT/Device/HarddiskVolume1/catalog",
      "\\??\\C:\\catalog",
    ]) {
      expect(routeMarketplaceSource({ source: "directory", path: localPath }).ok).toBe(false);
    }
  });
});

describe("lifecycle identity and location vocabulary", () => {
  it("qualifies plugin identity with the existing bounded marketplace grammar", () => {
    expect(qualifiedPluginIdentity("formatter", "official")).toEqual({ ok: true, value: "formatter@official" });
    expect(qualifiedPluginIdentity("tool@other", "official").ok).toBe(false);
    expect(qualifiedPluginIdentity("tool", "Bad_Market").ok).toBe(false);
    expect(qualifiedPluginIdentity("x".repeat(255), "official").ok).toBe(false);
  });

  it("freezes ownership labels, mutable scopes, digest shape, and generic bounds only", () => {
    const ownerships: readonly LifecycleOwnership[] = LIFECYCLE_OWNERSHIPS;
    const scopes: readonly MutablePluginScope[] = MUTABLE_PLUGIN_SCOPES;
    const digest: Sha256 = `sha256:${"a".repeat(64)}`;
    expect(ownerships).toEqual(["picc-owned", "claude-imported-readonly"]);
    expect(scopes).toEqual(["user", "project", "local"]);
    expect(digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(PLUGIN_LIFECYCLE_LIMITS).toEqual({
      maximumArrayItems: 1024,
      maximumDocumentBytes: 1024 * 1024,
      maximumFileCount: 100_000,
      maximumKeyLength: 128,
      maximumNesting: 32,
      maximumObjectKeys: 256,
      maximumStringLength: 8192,
    });
  });

  it("partitions profiles and checkout families collision-resistently without exposing paths", () => {
    const firstProfile = profileLocationKey("/home/alice/.claude", "posix");
    const secondProfile = profileLocationKey("/home/alice/.claude-alt", "posix");
    const firstCheckout = checkoutFamilyLocationKey("/work/repo/.git", "posix");
    const siblingCheckout = checkoutFamilyLocationKey("/work/repo/.git", "posix");
    const distinctCheckout = checkoutFamilyLocationKey("/work/other/.git", "posix");
    expect(firstProfile).toMatchObject({ ok: true, value: expect.stringMatching(/^profile-[A-Za-z0-9_-]{43}$/) });
    expect(firstCheckout).toMatchObject({ ok: true, value: expect.stringMatching(/^checkout-[A-Za-z0-9_-]{43}$/) });
    expect(firstProfile).not.toEqual(secondProfile);
    expect(firstCheckout).toEqual(siblingCheckout);
    expect(firstCheckout).not.toEqual(distinctCheckout);
    expect(JSON.stringify([firstProfile, firstCheckout])).not.toContain("alice");
  });

  it("rejects Windows device identities while retaining ordinary UNC location identities", () => {
    expect(canonicalLocationIdentity("\\\\server\\share\\profile", "win32")).toEqual({
      ok: true,
      value: "\\\\server\\share\\profile",
    });
    for (const location of [
      "\\\\?\\C:\\Users\\Alice",
      "//?/C:/Users/Alice",
      "\\\\?\\UNC\\server\\share\\profile",
      "\\\\.\\PhysicalDrive0",
      "\\\\?\\GLOBALROOT\\Device\\HarddiskVolume1\\profile",
      "\\\\.\\GLOBALROOT\\Device\\HarddiskVolume1\\profile",
      "//./GLOBALROOT/Device/HarddiskVolume1/profile",
      "\\??\\C:\\Users\\Alice",
    ]) {
      expect(canonicalLocationIdentity(location, "win32")).toMatchObject({
        ok: false,
        error: { code: "invalid-location" },
      });
    }
  });

  it("keeps active-checkout settings targets separate from checkout-family storage identity", () => {
    const common = {
      homeDir: "/home/alice",
      profilePath: "/home/alice/.claude",
      platform: "posix" as const,
      project: { activeCheckoutPath: "/work/feature-a", checkoutFamilyPath: "/work/repo/.git" },
    };
    const sibling = { ...common, project: { ...common.project, activeCheckoutPath: "/work/feature-b" } };
    const projectA = lifecycleSettingsTarget(common, "project");
    const projectB = lifecycleSettingsTarget(sibling, "project");
    expect(projectA).toMatchObject({ ok: true, value: { path: "/work/feature-a/.claude/settings.json", activeCheckoutPath: "/work/feature-a" } });
    expect(projectB).toMatchObject({ ok: true, value: { path: "/work/feature-b/.claude/settings.json", activeCheckoutPath: "/work/feature-b" } });
    if (!projectA.ok || !projectB.ok || projectA.value.scope === "user" || projectB.value.scope === "user") {
      throw new Error("expected project settings targets");
    }
    expect(projectA.value.checkoutFamilyKey).toBe(projectB.value.checkoutFamilyKey);
    expect(lifecycleSettingsTarget(common, "local")).toMatchObject({ ok: true, value: { path: "/work/feature-a/.claude/settings.local.json" } });
    expect(lifecycleSettingsTarget(common, "user")).toMatchObject({ ok: true, value: { path: "/home/alice/.claude/settings.json" } });
  });

  it("targets Windows user, project, and local settings under each active checkout", () => {
    const common = {
      homeDir: "C:\\Users\\Alice",
      profilePath: "C:\\Users\\Alice\\.claude",
      platform: "win32" as const,
      project: { activeCheckoutPath: "C:\\Work\\Feature-A", checkoutFamilyPath: "C:\\Work\\Repo\\.git" },
    };
    const sibling = { ...common, project: { ...common.project, activeCheckoutPath: "C:\\Work\\Feature-B" } };
    expect(lifecycleSettingsTarget(common, "user")).toMatchObject({
      ok: true,
      value: { path: "c:\\users\\alice\\.claude\\settings.json" },
    });
    const projectA = lifecycleSettingsTarget(common, "project");
    const projectB = lifecycleSettingsTarget(sibling, "project");
    expect(projectA).toMatchObject({
      ok: true,
      value: { path: "c:\\work\\feature-a\\.claude\\settings.json", activeCheckoutPath: "c:\\work\\feature-a" },
    });
    expect(projectB).toMatchObject({
      ok: true,
      value: { path: "c:\\work\\feature-b\\.claude\\settings.json", activeCheckoutPath: "c:\\work\\feature-b" },
    });
    expect(lifecycleSettingsTarget(sibling, "local")).toMatchObject({
      ok: true,
      value: { path: "c:\\work\\feature-b\\.claude\\settings.local.json" },
    });
    if (!projectA.ok || !projectB.ok || projectA.value.scope === "user" || projectB.value.scope === "user") {
      throw new Error("expected Windows project settings targets");
    }
    expect(projectA.value.checkoutFamilyKey).toBe(projectB.value.checkoutFamilyKey);
  });

  it("projects POSIX and Windows roots under the versioned PiCC store", () => {
    const posix = createLifecycleLocations({
      homeDir: "/home/alice",
      profilePath: "/home/alice/.claude",
      platform: "posix",
      project: { activeCheckoutPath: "/work/a", checkoutFamilyPath: "/work/repo/.git" },
    });
    const windowsUpper = createLifecycleLocations({
      homeDir: "C:\\Users\\Alice",
      profilePath: "C:\\Users\\Alice\\.claude",
      platform: "win32",
      project: { activeCheckoutPath: "C:\\Work\\A", checkoutFamilyPath: "C:\\Work\\Repo\\.git" },
    });
    const windowsLower = createLifecycleLocations({
      homeDir: "c:\\users\\alice",
      profilePath: "c:\\users\\alice\\.CLAUDE",
      platform: "win32",
      project: { activeCheckoutPath: "c:\\work\\b", checkoutFamilyPath: "c:\\work\\repo\\.GIT" },
    });
    expect(posix).toMatchObject({
      ok: true,
      value: {
        platform: "posix",
        root: "/home/alice/.picc/plugins/v1",
        profilePluginsRoot: expect.stringContaining("/profiles/profile-"),
        checkoutFamilyPluginsRoot: expect.stringContaining("/checkouts/checkout-"),
      },
    });
    expect(windowsUpper).toMatchObject({ ok: true, value: { platform: "win32", root: "c:\\users\\alice\\.picc\\plugins\\v1" } });
    if (!windowsUpper.ok || !windowsLower.ok) throw new Error("expected Windows locations");
    expect(windowsUpper.value.profileKey).toBe(windowsLower.value.profileKey);
    expect(windowsUpper.value.checkoutFamilyKey).toBe(windowsLower.value.checkoutFamilyKey);
  });

  it("keeps plugin data profile-wide while project and local scopes require a checkout family", () => {
    const locations = createLifecycleLocations({
      homeDir: "/home/alice",
      profilePath: "/home/alice/.claude",
      platform: "posix",
      project: { activeCheckoutPath: "/work/a", checkoutFamilyPath: "/work/repo/.git" },
    });
    if (!locations.ok) throw new Error("expected locations");
    const identity = "formatter@official" as QualifiedPluginIdentity;
    const data: PluginDataIdentity = pluginDataIdentity(locations.value.profileKey, identity);
    const userLocation: LifecycleScopeLocation = { scope: "user", profileKey: locations.value.profileKey };
    const projectLocation: LifecycleScopeLocation = {
      scope: "project",
      profileKey: locations.value.profileKey,
      checkoutFamilyKey: locations.value.checkoutFamilyKey!,
    };
    expect(data).toEqual({ profileKey: locations.value.profileKey, identity });
    expect(pluginDataPath(locations.value, identity)).toContain(`${locations.value.dataRoot}/plugin-`);
    expect(userLocation.scope).toBe("user");
    expect(projectLocation.scope).toBe("project");
    expect(checkoutFamilyKeyForScope("user", locations.value)).toEqual({ ok: true, value: undefined });
    expect(checkoutFamilyKeyForScope("project", locations.value)).toEqual({ ok: true, value: locations.value.checkoutFamilyKey });

    const otherFamily = createLifecycleLocations({
      homeDir: "/home/alice",
      profilePath: "/home/alice/.claude",
      platform: "posix",
      project: { activeCheckoutPath: "/other/a", checkoutFamilyPath: "/other/repo/.git" },
    });
    if (!otherFamily.ok) throw new Error("expected second checkout-family locations");
    expect(otherFamily.value.checkoutFamilyKey).not.toBe(locations.value.checkoutFamilyKey);
    expect(pluginDataIdentity(otherFamily.value.profileKey, identity)).toEqual(data);
    expect(pluginDataPath(otherFamily.value, identity)).toBe(pluginDataPath(locations.value, identity));

    const profileOnly = createLifecycleLocations({ homeDir: "/home/alice", profilePath: "/home/alice/.claude", platform: "posix" });
    if (!profileOnly.ok) throw new Error("expected profile locations");
    expect(checkoutFamilyKeyForScope("local", profileOnly.value)).toMatchObject({ ok: false, error: { code: "invalid-location" } });
  });
});

describe("cross-assembly declaration and evidence vocabulary", () => {
  it("types official archive catalog declarations and manifest default evidence", () => {
    const archive: PluginMarketplaceCatalogSource = {
      kind: "archive",
      url: "https://archive.example.org/tool.zip",
      sha256: "a".repeat(64),
    };
    const manifestFalse: PluginManifestDefaultEnabledEvidence = {
      presence: "explicit",
      value: false,
      sourcePath: "/plugin/.claude-plugin/plugin.json",
    };
    expect(archive.kind).toBe("archive");
    expect(manifestFalse.value).toBe(false);
  });

  it("applies existing, marketplace, manifest, then true initial-enablement precedence", () => {
    const manifestTrue = { presence: "explicit", value: true, sourcePath: "/plugin/plugin.json" } as const;
    const manifestFalse = { ...manifestTrue, value: false } as const;
    const manifestAbsent: PluginManifestDefaultEnabledEvidence = { presence: "absent", sourcePath: "/plugin/plugin.json" };
    expect(resolveInitialEnablement({ existingEffective: explicitDefault(false), marketplaceDefault: explicitDefault(true), manifestDefault: manifestTrue })).toBe(false);
    expect(resolveInitialEnablement({ existingEffective: explicitDefault(true), marketplaceDefault: explicitDefault(false), manifestDefault: manifestFalse })).toBe(true);
    expect(resolveInitialEnablement({ existingEffective: ABSENT_DEFAULT, marketplaceDefault: explicitDefault(false), manifestDefault: manifestTrue })).toBe(false);
    expect(resolveInitialEnablement({ existingEffective: ABSENT_DEFAULT, marketplaceDefault: explicitDefault(true), manifestDefault: manifestFalse })).toBe(true);
    expect(resolveInitialEnablement({ existingEffective: ABSENT_DEFAULT, marketplaceDefault: ABSENT_DEFAULT, manifestDefault: manifestFalse })).toBe(false);
    expect(resolveInitialEnablement({ existingEffective: ABSENT_DEFAULT, marketplaceDefault: ABSENT_DEFAULT, manifestDefault: manifestAbsent })).toBe(true);
  });
});

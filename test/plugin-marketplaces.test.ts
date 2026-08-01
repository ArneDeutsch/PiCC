import childProcess from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadPluginMarketplaceState, type PluginMarketplaceSettingsInputContribution } from "../src/claude/plugin-marketplaces.js";
import { loadSettings } from "../src/discovery/settings.js";
import { normalizeMarketplacePolicyDescriptor } from "../src/util/plugin-marketplace-descriptor.js";
import type { PluginMarketplaceComponentField } from "../src/types.js";

const knownFixture = fileURLToPath(new URL("./fixtures/claude-plugins/known-marketplaces.json", import.meta.url));
const catalogFixture = fileURLToPath(new URL("./fixtures/claude-plugins/marketplace-catalog.json", import.meta.url));
const temporaryDirectories: string[] = [];
const symlinkAvailable = (() => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "picc-symlink-probe-"));
  try {
    const target = path.join(root, "target");
    fs.mkdirSync(target);
    fs.symlinkSync(target, path.join(root, "link"), process.platform === "win32" ? "junction" : "dir");
    return true;
  } catch {
    return false;
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
})();

function temporaryRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "picc-marketplaces-"));
  temporaryDirectories.push(root);
  return root;
}

function copy(file: string, destination: string): void {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(file, destination);
}

function marketplace(root: string, name: string, catalog = catalogFixture): void {
  copy(catalog, path.join(root, name, ".claude-plugin", "marketplace.json"));
}

function writeMarketplaceState(root: string, catalog: Record<string, unknown>, source: unknown = { source: "github", repo: "example/official" }): string {
  const userDir = path.join(root, ".claude");
  fs.mkdirSync(path.join(userDir, "plugins"), { recursive: true });
  fs.writeFileSync(path.join(userDir, "plugins", "known_marketplaces.json"), JSON.stringify({ "official-marketplace": { source } }));
  const catalogPath = path.join(userDir, "plugins", "marketplaces", "official-marketplace", ".claude-plugin", "marketplace.json");
  fs.mkdirSync(path.dirname(catalogPath), { recursive: true });
  fs.writeFileSync(catalogPath, JSON.stringify(catalog));
  return userDir;
}

function catalog(plugins: unknown[], extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { name: "official-marketplace", owner: { name: "Example" }, plugins, ...extra };
}

function gitStructure(root: string): void {
  for (const directory of ["objects", "refs"]) fs.mkdirSync(path.join(root, ".git", directory), { recursive: true });
  fs.writeFileSync(path.join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
  fs.writeFileSync(path.join(root, ".git", "config"), "[core]\n\trepositoryformatversion = 0\n");
}

function settings(contributions: PluginMarketplaceSettingsInputContribution[]) {
  return {
    pluginMarketplaceSettings: contributions.map((contribution) => ({
      ...contribution,
      ...(contribution.extraKnownMarketplaces === undefined ? {} : {
        extraKnownMarketplaces: Object.fromEntries(Object.entries(contribution.extraKnownMarketplaces).map(([marketplaceName, value]) => [
          marketplaceName,
          typeof value === "object" && value !== null && !Array.isArray(value) && typeof (value as { source?: unknown }).source === "object" ? value : { source: value },
        ])),
      }),
    })),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe("loadPluginMarketplaceState", () => {
  it("derives primary catalogs beneath the user marketplace root and keeps declarations non-authoritative", () => {
    const root = temporaryRoot();
    const userDir = path.join(root, ".claude");
    copy(knownFixture, path.join(userDir, "plugins", "known_marketplaces.json"));
    marketplace(path.join(userDir, "plugins", "marketplaces"), "official-marketplace");

    const result = loadPluginMarketplaceState({ userDir, projectRoot: root, seedDirs: [] });

    expect(result.selectedRegistrations.map((item) => item.name)).toEqual(["official-marketplace"]);
    expect(result.selectedRegistrations[0]).toMatchObject({
      catalogPath: path.join(userDir, "plugins", "marketplaces", "official-marketplace", ".claude-plugin", "marketplace.json"),
      sourceProvenance: { field: "source", sourcePath: path.join(userDir, "plugins", "known_marketplaces.json"), key: "official-marketplace" },
      fixtureContract: "fixture-derived-unverified",
    });
    expect(result.entries.find((item) => item.name === "sample-plugin")).toMatchObject({
      identity: "sample-plugin@official-marketplace",
      strict: true,
      defaultEnabled: false,
      strictDeclaration: { value: true, presence: "explicit", provenance: { field: "strict" } },
      defaultEnabledDeclaration: { value: false, provenance: { field: "defaultEnabled" } },
      runtimeEffect: "declared-not-effective",
    });
    expect(result.catalogs[0]?.metadata).toMatchObject({ pluginRoot: "./runtime", provenance: { field: "metadata.pluginRoot" }, posture: "inert-lexical-effect-only" });
    expect(result.dependencies).toContainEqual(expect.objectContaining({
      targetIdentity: "shared-plugin@partner-marketplace",
      posture: "declared-locally-observable-not-resolved",
    }));
    expect(result.renames).toContainEqual(expect.objectContaining({
      from: "old-plugin",
      currentIdentity: "current-plugin@official-marketplace",
      status: "current",
      runtimeEffect: "declared-not-effective",
    }));
    expect(result.renames).toContainEqual(expect.objectContaining({ from: "removed-plugin", currentIdentity: null, status: "removed" }));
  });

  it("uses the first ordered seed containing an identity while retaining primary and duplicate evidence", () => {
    const root = temporaryRoot();
    const userDir = path.join(root, ".claude");
    copy(knownFixture, path.join(userDir, "plugins", "known_marketplaces.json"));
    const seedOne = path.join(root, "seed-one");
    const seedTwo = path.join(root, "seed-two");
    copy(knownFixture, path.join(seedOne, "known_marketplaces.json"));
    copy(knownFixture, path.join(seedTwo, "known_marketplaces.json"));
    marketplace(seedOne, "official-marketplace");
    marketplace(seedTwo, "official-marketplace");

    const result = loadPluginMarketplaceState({ userDir, projectRoot: root, seedDirs: [seedOne, seedTwo] });

    expect(result.registrations).toHaveLength(3);
    expect(result.selectedRegistrations[0]?.provenance.sourcePath).toBe(path.join(seedOne, "known_marketplaces.json"));
    expect(result.registrations.filter((item) => item.selected)).toHaveLength(1);
  });

  it("keeps primary/seed precedence separate and lets the later valid settings contribution win", () => {
    const root = temporaryRoot();
    const userDir = path.join(root, ".claude");
    copy(knownFixture, path.join(userDir, "plugins", "known_marketplaces.json"));
    const seed = path.join(root, "seed");
    copy(knownFixture, path.join(seed, "known_marketplaces.json"));
    const result = loadPluginMarketplaceState({ userDir, projectRoot: root, seedDirs: [seed], settings: settings([
      { scope: "user", sourcePath: "user", extraKnownMarketplaces: { "official-marketplace": { source: "github", repo: "settings/package" }, ambiguous: { source: "github", repo: "settings/one" } } },
      { scope: "managed", sourcePath: "managed", extraKnownMarketplaces: { ambiguous: { source: "github", repo: "settings/two" } } },
    ]) });
    expect(result.selectedRegistrations.find((item) => item.name === "official-marketplace")?.provenance.origin).toBe("seed");
    expect(result.selectedRegistrations.find((item) => item.name === "ambiguous")?.provenance).toMatchObject({ scope: "managed", sourcePath: "managed" });
    expect(result.registrations.filter((item) => item.name === "official-marketplace").map((item) => item.provenance.origin)).toEqual(["primary", "seed", "settings"]);
    expect(result.registrations.filter((item) => item.name === "ambiguous").map((item) => item.provenance.scope)).toEqual(["user", "managed"]);
  });

  it("keeps invalid-scope policy inert and preserves empty managed strict lockdown", () => {
    const root = temporaryRoot();
    const descriptor = { source: "github", repo: "example/official-marketplace" };
    const result = loadPluginMarketplaceState({
      userDir: path.join(root, ".claude"), projectRoot: root, seedDirs: [],
      settings: settings([
        { scope: "user", sourcePath: "user-settings", extraKnownMarketplaces: { "official-marketplace": descriptor }, blockedMarketplaces: [descriptor] },
        { scope: "managed", sourcePath: "managed-settings", strictKnownMarketplaces: [] },
      ]),
    });

    expect(result.selectedRegistrations).toHaveLength(1);
    expect(result.policies).toContainEqual(expect.objectContaining({ kind: "blocked", validScope: false, match: false }));
    expect(result.policies).toContainEqual(expect.objectContaining({ kind: "strict", validScope: true, emptyLockdown: true, match: false }));
    expect(result.policies.every((item) => item.posture === "claude-lifecycle-observation-not-enforced")).toBe(true);
  });

  it("resolves an unambiguous project-relative marketplace from a validated main-checkout anchor", () => {
    const root = temporaryRoot();
    gitStructure(root);
    const localRoot = path.join(root, "vendor", "marketplace");
    copy(catalogFixture, path.join(localRoot, ".claude-plugin", "marketplace.json"));

    const result = loadPluginMarketplaceState({
      userDir: path.join(root, ".claude"), projectRoot: root, seedDirs: [],
      settings: settings([{ scope: "project", sourcePath: "project-settings", extraKnownMarketplaces: {
        "official-marketplace": { source: "directory", path: "./vendor/marketplace" },
      } }]),
    });

    expect(result.selectedRegistrations).toHaveLength(1);
    expect(result.selectedRegistrations[0]).toMatchObject({ validity: "valid", catalogPath: path.join(localRoot, ".claude-plugin", "marketplace.json") });
    expect(result.entries).not.toHaveLength(0);
  });

  it("matches only valid managed exact and bounded host-pattern policy", () => {
    const root = temporaryRoot();
    const source = { source: "github", repo: "example/repo" };
    const result = loadPluginMarketplaceState({
      userDir: path.join(root, ".claude"), projectRoot: root, seedDirs: [],
      settings: settings([
        { scope: "user", sourcePath: "user-settings", extraKnownMarketplaces: { "official-marketplace": source } },
        { scope: "managed", sourcePath: "managed-settings", blockedMarketplaces: [source], strictKnownMarketplaces: [{ source: "hostPattern", hostPattern: "^github\\.com$" }] },
      ]),
    });

    expect(result.policies).toContainEqual(expect.objectContaining({ kind: "blocked", validScope: true, match: true }));
    expect(result.policies).toContainEqual(expect.objectContaining({ kind: "strict", validScope: true, match: true }));
  });

  it("rejects project absolute and traversal local sources before probing them", () => {
    const root = temporaryRoot();
    const open = vi.spyOn(fs, "openSync");
    const result = loadPluginMarketplaceState({
      userDir: path.join(root, ".claude"), projectRoot: root, seedDirs: [],
      settings: settings([{ scope: "project", sourcePath: "project-settings", extraKnownMarketplaces: {
        "absolute-marketplace": { source: "directory", path: path.join(root, "outside") },
        "traversal-marketplace": { source: "directory", path: "../outside" },
        "windows-marketplace": { source: "directory", path: "C:\\outside" },
      } }]),
    });

    expect(result.registrations.every((item) => item.validity === "rejected")).toBe(true);
    expect(open.mock.calls.map((call) => String(call[0]))).not.toContain(path.join(root, "outside", ".claude-plugin", "marketplace.json"));
    expect(result.diagnostics.filter((item) => item.message.includes("was not probed"))).toHaveLength(3);
  });

  it("does not write, execute, scan caches, or access the network for remote and rejected descriptors", () => {
    const root = temporaryRoot();
    const writeTraps = [
      vi.spyOn(fs, "writeFileSync").mockImplementation(() => { throw new Error("write attempted"); }),
      vi.spyOn(fs, "appendFileSync").mockImplementation(() => { throw new Error("append attempted"); }),
      vi.spyOn(fs, "mkdirSync").mockImplementation(() => { throw new Error("mkdir attempted"); }),
    ];
    const scanTrap = vi.spyOn(fs, "readdirSync").mockImplementation((() => { throw new Error("scan attempted"); }) as typeof fs.readdirSync);
    const processTraps = [
      vi.spyOn(childProcess, "spawn").mockImplementation((() => { throw new Error("spawn attempted"); }) as typeof childProcess.spawn),
      vi.spyOn(childProcess, "execFileSync").mockImplementation((() => { throw new Error("exec attempted"); }) as typeof childProcess.execFileSync),
    ];
    const networkTraps = [
      vi.spyOn(http, "request").mockImplementation((() => { throw new Error("http attempted"); }) as typeof http.request),
      vi.spyOn(https, "request").mockImplementation((() => { throw new Error("https attempted"); }) as typeof https.request),
      vi.spyOn(net, "connect").mockImplementation((() => { throw new Error("network attempted"); }) as typeof net.connect),
    ];
    const originalFetch = globalThis.fetch;
    const fetchTrap = vi.fn(() => Promise.reject(new Error("fetch attempted")));
    globalThis.fetch = fetchTrap;
    try {
      const result = loadPluginMarketplaceState({
        userDir: path.join(root, ".claude"), projectRoot: root, seedDirs: [],
        settings: settings([{ scope: "project", sourcePath: "project-settings", extraKnownMarketplaces: {
          "remote-marketplace": { source: "url", url: "custom://user:secret@example.test/repo?token=secret" },
          "rejected-marketplace": { source: "directory", path: "../never-probe" },
        } }]),
      });
      expect(result.registrations).toHaveLength(2);
      for (const trap of [...writeTraps, scanTrap, ...processTraps, ...networkTraps]) expect(trap).not.toHaveBeenCalled();
      expect(fetchTrap).not.toHaveBeenCalled();
      expect(JSON.stringify(result)).not.toContain("secret");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("isolates a catalog-name disagreement and malformed rename siblings", () => {
    const root = temporaryRoot();
    const userDir = path.join(root, ".claude");
    fs.mkdirSync(path.join(userDir, "plugins"), { recursive: true });
    fs.writeFileSync(path.join(userDir, "plugins", "known_marketplaces.json"), JSON.stringify({ "declared-marketplace": { source: { source: "github", repo: "example/repo" } } }));
    const catalog = path.join(root, "bad.json");
    fs.writeFileSync(catalog, JSON.stringify({ name: "different-marketplace", plugins: [{ name: "safe-plugin" }] }));
    marketplace(path.join(userDir, "plugins", "marketplaces"), "declared-marketplace", catalog);

    const result = loadPluginMarketplaceState({ userDir, projectRoot: root, seedDirs: [] });

    expect(result.entries).toEqual([]);
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ message: expect.stringContaining("disagrees") }));
  });

  it("decouples first-seed selection from a full primary evidence budget", () => {
    const root = temporaryRoot();
    const userDir = path.join(root, ".claude");
    const primary = Object.fromEntries(Array.from({ length: 256 }, (_, index) => {
      const id = `marketplace-${String(index).padStart(3, "0")}`;
      return [id, { source: { source: "github", repo: `example/${id}` } }];
    }));
    fs.mkdirSync(path.join(userDir, "plugins"), { recursive: true });
    fs.writeFileSync(path.join(userDir, "plugins", "known_marketplaces.json"), JSON.stringify(primary));
    const seed = path.join(root, "seed");
    fs.mkdirSync(seed, { recursive: true });
    fs.writeFileSync(path.join(seed, "known_marketplaces.json"), JSON.stringify({ "marketplace-255": { source: { source: "github", repo: "example/replacement" } } }));

    const result = loadPluginMarketplaceState({ userDir, projectRoot: root, seedDirs: [seed] });

    expect(result.registrations).toHaveLength(256);
    expect(result.omissions.registrations).toBe(1);
    expect(result.selectedRegistrations.find((item) => item.name === "marketplace-255")?.provenance.origin).toBe("seed");
  });

  it("bounds every retained state collection with deterministic omission evidence", () => {
    const root = temporaryRoot();
    const components = Array.from({ length: 1025 }, (_, index) => `./component-${index}`);
    const dependencies = Array.from({ length: 1025 }, (_, index) => `dependency-${index}`);
    const plugins = Array.from({ length: 1025 }, (_, index) => ({
      name: `plugin-${index}`,
      source: index === 0 ? { source: "npm", package: "example-package" } : `./plugin-${index}`,
      ...(index === 0 ? { commands: components, dependencies } : {}),
      metadata: { pluginRoot: `./plugin-${index}` },
      userConfig: { token: `never-retain-${index}` },
    }));
    const renames = Object.fromEntries(Array.from({ length: 513 }, (_, index) => [`old-${index}`, `plugin-${index}`]));
    const allowCrossMarketplaceDependenciesOn = Array.from({ length: 257 }, (_, index) => `allowed-${index}`);
    const userDir = writeMarketplaceState(root, catalog(plugins, { renames, allowCrossMarketplaceDependenciesOn }));

    const result = loadPluginMarketplaceState({ userDir, projectRoot: root, seedDirs: [] });

    expect(result.entries).toHaveLength(1024);
    expect(result.dependencies).toHaveLength(1024);
    expect(result.allowlists).toHaveLength(256);
    expect(result.renames).toHaveLength(512);
    expect(result.entries.flatMap((entry) => Object.values(entry.components)).flat()).toHaveLength(1024);
    expect(result.entries.filter((entry) => entry.userConfig !== undefined)).toHaveLength(256);
    for (const key of ["entries", "components", "dependencies", "renames", "allowlists", "userConfig"] as const) expect(result.omissions[key]).toBeGreaterThan(0);
    expect(JSON.stringify(result)).not.toContain("never-retain-");
  });

  it("bounds selected registrations, policies, and diagnostics state-wide", () => {
    const root = temporaryRoot();
    const extras = Object.fromEntries(Array.from({ length: 257 }, (_, index) => [`market-${index}`, { source: "github", repo: `example/package-${index}` }]));
    const policies = Array.from({ length: 257 }, (_, index) => ({ source: "github", repo: `example/package-${index}` }));
    const result = loadPluginMarketplaceState({
      userDir: path.join(root, ".claude"), projectRoot: root, seedDirs: [],
      settings: settings([{ scope: "managed", sourcePath: "managed", extraKnownMarketplaces: extras, blockedMarketplaces: policies }]),
    });
    expect(result.registrations).toHaveLength(256);
    expect(result.selectedRegistrations).toHaveLength(256);
    expect(result.policies).toHaveLength(256);
    expect(result.omissions).toMatchObject({ registrations: 1, selectedRegistrations: 1, policies: 1 });

    const malformed = Object.fromEntries(Array.from({ length: 140 }, (_, index) => [`Bad_${index}`, null]));
    const userDir = path.join(root, "bad-user");
    fs.mkdirSync(path.join(userDir, "plugins"), { recursive: true });
    fs.writeFileSync(path.join(userDir, "plugins", "known_marketplaces.json"), JSON.stringify(malformed));
    const diagnosed = loadPluginMarketplaceState({ userDir, projectRoot: root, seedDirs: [] });
    expect(diagnosed.diagnostics).toHaveLength(128);
    expect(diagnosed.omissions.diagnostics).toBe(12);
  });

  it("never throws when closing a bounded JSON read fails", () => {
    const root = temporaryRoot();
    const userDir = path.join(root, ".claude");
    copy(knownFixture, path.join(userDir, "plugins", "known_marketplaces.json"));
    vi.spyOn(fs, "closeSync").mockImplementation(() => { throw new Error("close failed"); });

    expect(() => loadPluginMarketplaceState({ userDir, projectRoot: root, seedDirs: [] })).not.toThrow();
    expect(loadPluginMarketplaceState({ userDir, projectRoot: root, seedDirs: [] }).registrations).toEqual([]);
  });

  it("parses nested registration records separately from documented catalog plugin sources", () => {
    const root = temporaryRoot();
    const valid: Record<string, unknown> = {
      github: { source: "github", repo: "owner/repo", ref: "main" },
      git: { source: "git", url: "ssh://user:secret@example.test/repo?token=x#frag", ref: "main" },
      url: { source: "url", url: "custom://user:secret@example.test/plugin?token=x#frag" },
      directory: { source: "directory", path: "./marketplace" }, file: { source: "file", path: "./marketplace.json" },
    };
    const invalid: Record<string, unknown> = {
      npm: { source: "npm", package: "package" }, "git-subdir": { source: "git-subdir", url: "https://example.test/repo", path: "plugins/x" },
      relative: "./plugin", extra: { source: "github", repo: "owner/repo", surprise: true }, direct: { source: "github", repo: "owner/direct" },
    };
    const nested = Object.fromEntries(Object.entries(valid).map(([key, value]) => [`${key}-market`, { source: value }]));
    const rejected = Object.fromEntries(Object.entries(invalid).map(([key, value]) => [`${key}-market`, key === "direct" ? value : { source: value }]));
    const result = loadPluginMarketplaceState({ userDir: path.join(root, ".claude"), projectRoot: root, seedDirs: [], settings: { pluginMarketplaceSettings: [{ scope: "user", sourcePath: "user", extraKnownMarketplaces: { ...nested, ...rejected } }] } });

    expect(result.registrations.map((item) => item.source.kind).sort()).toEqual(Object.keys(valid).sort());
    expect(JSON.stringify(result)).not.toMatch(/secret|token=x|frag/);
    expect(result.diagnostics.filter((item) => item.message.includes("nested source descriptor"))).toHaveLength(Object.keys(invalid).length);
  });

  it("matches exact and documented patterns only, leaving invalid patterns inert", () => {
    const root = temporaryRoot();
    gitStructure(root);
    fs.mkdirSync(path.join(root, "vendor"));
    const source = { source: "github", repo: "owner/repo" };
    const result = loadPluginMarketplaceState({
      userDir: path.join(root, ".claude"), projectRoot: root, seedDirs: [],
      settings: settings([
        { scope: "user", sourcePath: "user", extraKnownMarketplaces: { official: source } },
        { scope: "project", sourcePath: "project", extraKnownMarketplaces: { local: { source: "directory", path: "./vendor" } } },
        { scope: "managed", sourcePath: "managed", blockedMarketplaces: [source, { source: "github", repo: "other/repo" }], strictKnownMarketplaces: [
          { source: "hostPattern", hostPattern: "^github\\.com$" }, { source: "hostPattern", hostPattern: "^gitlab\\.com$" }, { source: "pathPattern", pathPattern: "^\\./vendor$" }, { source: "pathPattern", pathPattern: "^\\./other$" }, { source: "hostPattern", hostPattern: "(complex)+" },
        ] },
      ]),
    });
    expect(result.policies.map((item) => item.match)).toEqual([true, false, true, false, "indeterminate-unsupported-regex-subset", true, false]);
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ message: expect.stringContaining("unsafe source descriptor") }));
  });

  it("requires owner.name and preserves version, revision, and source-SHA declaration provenance", () => {
    const root = temporaryRoot();
    let userDir = writeMarketplaceState(root, { name: "official-marketplace", plugins: [{ name: "ignored", source: "./ignored" }] });
    expect(loadPluginMarketplaceState({ userDir, projectRoot: root, seedDirs: [] }).entries).toEqual([]);

    userDir = writeMarketplaceState(root, catalog([
      { name: "versioned", source: "./versioned", version: "1.0.0", revision: "rev" },
      { name: "revised", source: "./revised", revision: "rev-2" },
      { name: "sha-pinned", source: { source: "github", repo: "owner/repo", sha: "dddddddddddddddddddddddddddddddddddddddd" } },
    ]));
    const result = loadPluginMarketplaceState({ userDir, projectRoot: root, seedDirs: [] });
    expect(result.entries.map((entry) => entry.release?.kind)).toEqual(["revision", "source-sha", "version"]);
    expect(result.entries.find((entry) => entry.name === "versioned")).toMatchObject({ version: "1.0.0", revision: "rev", release: { kind: "version", provenance: { field: "version" } } });
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ message: expect.stringContaining("both version and revision") }));
  });

  it("validates components, dependencies, allowlist siblings, and duplicate identities independently", () => {
    const root = temporaryRoot();
    const userDir = writeMarketplaceState(root, catalog([
      { name: "safe-plugin", source: "./safe", commands: "./one.md", skills: ["./a", "./b"], agents: ["ok", 4], dependencies: [
        "same", { name: "allowed", marketplace: "partner", version: "^1" }, { name: "blocked", marketplace: "other" },
        { name: "bad-market", marketplace: 4 }, { name: "bad-version", version: 4 },
      ] },
      { name: "safe-plugin", source: "./duplicate" }, { name: "missing-source" }, { name: "sibling-plugin", source: "./sibling" },
    ], { allowCrossMarketplaceDependenciesOn: ["partner", 4] }));
    const result = loadPluginMarketplaceState({ userDir, projectRoot: root, seedDirs: [] });
    const safe = result.entries.find((entry) => entry.name === "safe-plugin")!;
    expect(Object.fromEntries(Object.entries(safe.components).map(([field, declarations]) => [field, declarations.map((item) => item.kind === "path" ? item.value : undefined)]))).toEqual({ commands: ["./one.md"], skills: ["./a", "./b"] });
    expect(safe.components.skills?.map((item) => item.provenance)).toEqual([
      expect.objectContaining({ field: "skills", entryIndex: 0, itemIndex: 0 }), expect.objectContaining({ field: "skills", entryIndex: 0, itemIndex: 1 }),
    ]);
    expect(safe.dependencies.map((dependency) => [dependency.targetIdentity, dependency.crossMarketplace])).toEqual([
      ["same@official-marketplace", "same-marketplace"], ["allowed@partner", "declared-allowed"], ["blocked@other", "declared-not-allowed"],
    ]);
    expect(safe.dependencies.every((dependency) => dependency.declaringIdentity === safe.identity && dependency.provenance.field === "dependencies" && dependency.provenance.itemIndex !== undefined)).toBe(true);
    expect(safe.dependencies.find((dependency) => dependency.version)?.versionStatus).toBe("syntax-unverified-not-resolved");
    expect(result.entries.map((entry) => entry.name)).toEqual(["safe-plugin", "sibling-plugin"]);
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ message: expect.stringContaining("agents declaration") }),
      expect.objectContaining({ message: expect.stringContaining("malformed dependency") }),
      expect.objectContaining({ message: expect.stringContaining("allowlist contains") }),
      expect.objectContaining({ message: expect.stringContaining("duplicate conflict for safe-plugin@official-marketplace") }),
    ]));
  });

  it("classifies rename current, removal, chain, cycle, dangling, and malformed siblings", () => {
    const root = temporaryRoot();
    const userDir = writeMarketplaceState(root, catalog([{ name: "current", source: "./current" }], { renames: {
      direct: "current", first: "middle", middle: "current", removed: null, "cycle-a": "cycle-b", "cycle-b": "cycle-a", dangling: "missing", malformed: 4,
    } }));
    const result = loadPluginMarketplaceState({ userDir, projectRoot: root, seedDirs: [] });
    expect(Object.fromEntries(result.renames.map((rename) => [rename.from, rename.status]))).toMatchObject({
      direct: "current", first: "current", middle: "current", removed: "removed", "cycle-a": "cycle", "cycle-b": "cycle", dangling: "dangling",
    });
    expect(result.renames.some((rename) => rename.from === "malformed")).toBe(false);
  });

  it("retains only a safe userConfig key/type summary and safe top-level metadata", () => {
    const root = temporaryRoot();
    const userDir = writeMarketplaceState(root, catalog([{ name: "configured", source: "./configured", userConfig: {
      token: "raw-secret", endpoint: "https://user:secret@example.test/?token=x", "https://secret.example": true, nested: { password: "raw-secret" },
    } }], { metadata: { pluginRoot: "https://user:secret@example.test/root?token=x" } }));
    const result = loadPluginMarketplaceState({ userDir, projectRoot: root, seedDirs: [] });
    expect(result.catalogs[0]?.metadata).toBeUndefined();
    expect(result.entries[0]?.userConfig).toMatchObject({ keys: [
      { key: "endpoint", type: "string" }, { key: "<redacted-key>", type: "boolean" }, { key: "nested", type: "object" }, { key: "token", type: "string" },
    ], omitted: 0, provenance: { field: "userConfig", entryIndex: 0 } });
    expect(JSON.stringify(result)).not.toMatch(/raw-secret|user:secret|token=x/);
  });

  it("anchors linked-worktree project sources to only a bounded, reciprocally verified main checkout", () => {
    const root = temporaryRoot();
    const main = path.join(root, "main");
    const worktree = path.join(root, "worktree");
    gitStructure(main);
    const admin = path.join(main, ".git", "worktrees", "linked");
    fs.mkdirSync(admin, { recursive: true });
    fs.mkdirSync(worktree, { recursive: true });
    fs.writeFileSync(path.join(worktree, ".git"), `gitdir: ${admin}\n`);
    fs.writeFileSync(path.join(admin, "gitdir"), path.join(worktree, ".git"));
    fs.writeFileSync(path.join(admin, "commondir"), "../..");
    fs.mkdirSync(path.join(main, "vendor", ".claude-plugin"), { recursive: true });
    fs.writeFileSync(path.join(main, "vendor", ".claude-plugin", "marketplace.json"), JSON.stringify(catalog([])));
    const contribution = settings([{ scope: "project", sourcePath: "project", extraKnownMarketplaces: { "official-marketplace": { source: "directory", path: "./vendor" } } }]);

    const valid = loadPluginMarketplaceState({ userDir: path.join(root, ".claude"), projectRoot: worktree, seedDirs: [], settings: contribution });
    expect(valid.selectedRegistrations[0]?.catalogPath).toBe(path.join(main, "vendor", ".claude-plugin", "marketplace.json"));

    const pointer = `gitdir: ${admin}\n`;
    fs.writeFileSync(path.join(worktree, ".git"), pointer + " ".repeat(16 * 1024 + 1));
    const oversized = loadPluginMarketplaceState({ userDir: path.join(root, ".claude"), projectRoot: worktree, seedDirs: [], settings: contribution });
    expect(oversized.selectedRegistrations).toEqual([]);
    expect(oversized.registrations[0]?.validity).toBe("rejected");
    fs.writeFileSync(path.join(worktree, ".git"), pointer);

    fs.writeFileSync(path.join(admin, "gitdir"), path.join(root, "forged", ".git"));
    const forged = loadPluginMarketplaceState({ userDir: path.join(root, ".claude"), projectRoot: worktree, seedDirs: [], settings: contribution });
    expect(forged.selectedRegistrations).toEqual([]);
    expect(forged.registrations[0]?.validity).toBe("rejected");

    fs.writeFileSync(path.join(admin, "gitdir"), path.join(worktree, ".git"));
    const otherRepo = path.join(root, "other-valid-repo");
    gitStructure(otherRepo);
    fs.mkdirSync(path.join(otherRepo, ".git", "worktrees"), { recursive: true });
    fs.writeFileSync(path.join(admin, "commondir"), path.relative(admin, path.join(otherRepo, ".git")));
    const open = vi.spyOn(fs, "openSync");
    const forgedCommon = loadPluginMarketplaceState({ userDir: path.join(root, ".claude"), projectRoot: worktree, seedDirs: [], settings: contribution });
    expect(forgedCommon.selectedRegistrations).toEqual([]);
    expect(forgedCommon.registrations[0]?.validity).toBe("rejected");
    expect(open.mock.calls.some((call) => String(call[0]).endsWith(path.join("vendor", ".claude-plugin", "marketplace.json")))).toBe(false);
  });

  it("rejects portable rooted/device/UNC/traversal forms without target canonical/stat/open probes", () => {
    const root = temporaryRoot();
    gitStructure(root);
    const targets = ["/outside", "../outside", "C:\\outside", "\\\\server\\share", "\\\\?\\C:\\device", "\\\\.\\pipe\\name"];
    const declarations = Object.fromEntries(targets.map((target, index) => [`market-${index}`, { source: "directory", path: target }]));
    const realpath = vi.spyOn(fs.realpathSync, "native");
    const stat = vi.spyOn(fs, "statSync");
    const open = vi.spyOn(fs, "openSync");
    const result = loadPluginMarketplaceState({ userDir: path.join(root, ".claude"), projectRoot: root, seedDirs: [], settings: settings([{ scope: "local", sourcePath: "local", extraKnownMarketplaces: declarations }]) });
    expect(result.registrations.every((entry) => entry.validity === "rejected")).toBe(true);
    for (const target of targets) {
      expect(realpath.mock.calls.some((call) => String(call[0]).includes(target))).toBe(false);
      expect(stat.mock.calls.some((call) => String(call[0]).includes(target))).toBe(false);
      expect(open.mock.calls.some((call) => String(call[0]).includes(target))).toBe(false);
    }
  });

  it("accepts validated user and managed absolute roots on the native platform", () => {
    const root = temporaryRoot();
    const userMarketplace = path.join(root, "user-marketplace");
    const managedMarketplace = path.join(root, "managed-marketplace");
    for (const marketplaceRoot of [userMarketplace, managedMarketplace]) {
      fs.mkdirSync(path.join(marketplaceRoot, ".claude-plugin"), { recursive: true });
      fs.writeFileSync(path.join(marketplaceRoot, ".claude-plugin", "marketplace.json"), JSON.stringify(catalog([])));
    }
    const result = loadPluginMarketplaceState({ userDir: path.join(root, ".claude"), projectRoot: root, seedDirs: [], settings: settings([
      { scope: "user", sourcePath: "user", extraKnownMarketplaces: { "official-marketplace": { source: "directory", path: userMarketplace } } },
      { scope: "managed", sourcePath: "managed", extraKnownMarketplaces: { "managed-marketplace": { source: "directory", path: managedMarketplace } } },
    ]) });
    expect(result.registrations.every((entry) => entry.validity === "valid")).toBe(true);
  });

  it.runIf(process.platform !== "win32")("rejects Windows drive/device/UNC absolute roots in user scope on POSIX", () => {
    const root = temporaryRoot();
    const paths = ["C:\\outside", "\\\\?\\C:\\outside", "\\\\server\\share"];
    const result = loadPluginMarketplaceState({ userDir: path.join(root, ".claude"), projectRoot: root, seedDirs: [], settings: settings([{ scope: "user", sourcePath: "user", extraKnownMarketplaces: Object.fromEntries(paths.map((value, index) => [`market-${index}`, { source: "directory", path: value }])) }]) });
    expect(result.selectedRegistrations.every((entry) => entry.validity === "rejected")).toBe(true);
  });

  it.runIf(symlinkAvailable)("rejects project symlink escapes", () => {
    const root = temporaryRoot();
    gitStructure(root);
    const outside = temporaryRoot();
    fs.mkdirSync(path.join(outside, ".claude-plugin"), { recursive: true });
    fs.writeFileSync(path.join(outside, ".claude-plugin", "marketplace.json"), JSON.stringify(catalog([])));
    fs.symlinkSync(outside, path.join(root, "escaped"), process.platform === "win32" ? "junction" : "dir");
    const result = loadPluginMarketplaceState({ userDir: path.join(root, ".claude"), projectRoot: root, seedDirs: [], settings: settings([{ scope: "project", sourcePath: "project", extraKnownMarketplaces: { "official-marketplace": { source: "directory", path: "./escaped" } } }]) });
    expect(result.selectedRegistrations).toEqual([]);
    expect(result.registrations[0]).toMatchObject({ validity: "rejected" });
    expect(result.registrations[0]?.catalogPath).toBeUndefined();
  });

  it("supports environment-delimited direct and nested seed layouts and reads only allowlisted JSON files", () => {
    const root = temporaryRoot();
    const direct = path.join(root, "direct");
    const nested = path.join(root, "nested");
    for (const seed of [direct, nested]) {
      fs.mkdirSync(seed, { recursive: true });
      fs.writeFileSync(path.join(seed, "known_marketplaces.json"), JSON.stringify({ "official-marketplace": { source: { source: "github", repo: "example/seed-package" } } }));
    }
    marketplace(direct, "official-marketplace");
    marketplace(path.join(nested, "marketplaces"), "official-marketplace");
    const open = vi.spyOn(fs, "openSync");
    const result = loadPluginMarketplaceState({ userDir: path.join(root, ".claude"), projectRoot: root, env: { CLAUDE_CODE_PLUGIN_SEED_DIR: [direct, nested].join(path.delimiter) } });
    expect(result.selectedRegistrations[0]?.provenance.sourcePath).toBe(path.join(direct, "known_marketplaces.json"));
    expect(result.registrations.find((entry) => entry.provenance.sourcePath === path.join(nested, "known_marketplaces.json"))?.catalogPath).toBe(path.join(nested, "marketplaces", "official-marketplace", ".claude-plugin", "marketplace.json"));
    expect(new Set(open.mock.calls.map((call) => String(call[0])))).toEqual(new Set([
      path.join(direct, "known_marketplaces.json"), path.join(nested, "known_marketplaces.json"),
      path.join(direct, "official-marketplace", ".claude-plugin", "marketplace.json"),
    ]));
  });

  it("uses captured ascending order for settings-only same-name selection", () => {
    const root = temporaryRoot();
    const contributions = (["user", "project", "local", "managed"] as const).map((scope, index) => ({
      scope, sourcePath: `${scope}-${index}`, extraKnownMarketplaces: { shared: { source: "github", repo: `example/package-${index}` } },
    }));
    contributions.push({ scope: "managed", sourcePath: "managed-later", extraKnownMarketplaces: { shared: { source: "github", repo: "example/package-later" } } });
    const result = loadPluginMarketplaceState({ userDir: path.join(root, ".claude"), projectRoot: root, seedDirs: [], settings: settings(contributions) });
    expect(result.selectedRegistrations[0]).toMatchObject({ source: { kind: "github", repo: "example/package-later" }, provenance: { sourcePath: "managed-later" } });
    expect(result.registrations).toHaveLength(5);
  });

  it("materializes file descriptors directly and directory descriptors through the documented suffix", () => {
    const root = temporaryRoot();
    gitStructure(root);
    const direct = path.join(root, "catalog.json");
    fs.writeFileSync(direct, JSON.stringify(catalog([{ name: "from-file", source: "./plugin" }])));
    const directory = path.join(root, "directory-market");
    fs.mkdirSync(path.join(directory, ".claude-plugin"), { recursive: true });
    fs.writeFileSync(path.join(directory, ".claude-plugin", "marketplace.json"), JSON.stringify({ ...catalog([{ name: "from-directory", source: "./plugin" }]), name: "directory-marketplace" }));
    const result = loadPluginMarketplaceState({ userDir: path.join(root, ".claude"), projectRoot: root, seedDirs: [], settings: settings([{ scope: "project", sourcePath: "project", extraKnownMarketplaces: {
      "official-marketplace": { source: "file", path: "./catalog.json" }, "directory-marketplace": { source: "directory", path: "./directory-market" },
    } }]) });
    expect(result.selectedRegistrations.map((item) => item.catalogPath)).toEqual([path.join(directory, ".claude-plugin", "marketplace.json"), direct]);
    expect(result.entries.map((entry) => entry.name)).toEqual(["from-directory", "from-file"]);
  });

  it("accepts canonical absolute file catalogs only from user and managed scopes", () => {
    const root = temporaryRoot();
    const declarations: PluginMarketplaceSettingsInputContribution[] = [];
    for (const [scope, marketName] of [["user", "user-file-market"], ["managed", "managed-file-market"]] as const) {
      const file = path.join(root, `${marketName}.json`);
      fs.writeFileSync(file, JSON.stringify({ name: marketName, owner: { name: "Owner" }, plugins: [{ name: `${scope}-plugin`, source: "./plugin" }] }));
      declarations.push({ scope, sourcePath: `${scope}-settings`, extraKnownMarketplaces: { [marketName]: { source: "file", path: file } } });
    }
    const result = loadPluginMarketplaceState({ userDir: path.join(root, ".claude"), projectRoot: root, seedDirs: [], settings: settings(declarations) });
    expect(result.entries.map((entry) => entry.identity)).toEqual(["managed-plugin@managed-file-market", "user-plugin@user-file-market"]);
    expect(result.selectedRegistrations.every((registration) => registration.validity === "valid" && registration.catalogPath?.endsWith(".json"))).toBe(true);
  });

  it("rejects URI-like and credential-bearing local paths without retaining canaries", () => {
    const root = temporaryRoot();
    const canaries = ["https:user:secret@host/path", "git:user:secret@host/path", "user:secret@host/path", "C:\\user:secret@host\\path"];
    const result = loadPluginMarketplaceState({ userDir: path.join(root, ".claude"), projectRoot: root, seedDirs: [], settings: settings([{ scope: "user", sourcePath: "user", extraKnownMarketplaces: Object.fromEntries(canaries.map((value, index) => [`market-${index}`, { source: "file", path: value }])) }]) });
    expect(result.registrations).toHaveLength(canaries.length);
    expect(result.registrations.every((registration) => registration.validity === "rejected" && registration.selected === false)).toBe(true);
    const serialized = JSON.stringify(result);
    for (const canary of ["user:secret", "secret@host"]) expect(serialized).not.toContain(canary);
  });

  it("keeps component/default provenance and duplicate conflict evidence decision-ready", () => {
    const root = temporaryRoot();
    const allComponents = Object.fromEntries(["commands", "agents", "skills", "hooks", "mcpServers", "lspServers"].map((field) => [field, `./${field}`]));
    const userDir = writeMarketplaceState(root, catalog([
      { name: "complete", source: { source: "github", repo: "owner/repo", ref: "main", sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }, description: "Visible description", ...allComponents },
      { name: "complete", source: "./loser" },
    ]));
    const result = loadPluginMarketplaceState({ userDir, projectRoot: root, seedDirs: [] });
    const entry = result.entries[0]!;
    expect(entry.description).toBe("Visible description");
    expect(entry.strictDeclaration).toMatchObject({ presence: "default", value: true, provenance: { field: "strict", entryIndex: 0 } });
    expect(entry.defaultEnabledDeclaration).toMatchObject({ presence: "default", value: true, provenance: { field: "defaultEnabled", entryIndex: 0 } });
    expect(entry).toMatchObject({ defaultEnabled: true, runtimeEffect: "declared-not-effective" });
    for (const field of Object.keys(allComponents) as PluginMarketplaceComponentField[]) {
      const declaration = entry.components[field]?.[0];
      expect(declaration).toMatchObject({ kind: "path", value: `./${field}`, provenance: { field, entryIndex: 0 } });
      expect(declaration?.provenance).not.toHaveProperty("itemIndex");
    }
    expect(result.conflicts).toEqual([{ identity: "complete@official-marketplace", winner: expect.objectContaining({ field: "name", entryIndex: 0 }), loser: expect.objectContaining({ field: "name", entryIndex: 1 }), posture: "observed-conflict-not-effective" }]);
  });

  it("bounds duplicate conflict evidence and accounts for capped diagnostics", () => {
    const root = temporaryRoot();
    const userDir = writeMarketplaceState(root, catalog(Array.from({ length: 258 }, (_, index) => ({ name: "duplicate", source: `./source-${index}` }))));
    const result = loadPluginMarketplaceState({ userDir, projectRoot: root, seedDirs: [] });
    expect(result.conflicts).toHaveLength(256);
    expect(result.omissions.conflicts).toBe(1);
    expect(result.diagnostics).toHaveLength(128);
    expect(result.omissions.diagnostics).toBe(129);
    expect(result.conflicts[0]).toMatchObject({ identity: "duplicate@official-marketplace", winner: { entryIndex: 0 }, loser: { entryIndex: 1 } });
  });

  it("uses bounded semantic indexes across display caps without affirmative false negatives", () => {
    const root = temporaryRoot();
    const allowlist = Array.from({ length: 257 }, (_, index) => `market-${index}`);
    const plugins = Array.from({ length: 1025 }, (_, index) => ({ name: `plugin-${String(index).padStart(4, "0")}`, source: `./plugin-${index}`, ...(index === 0 ? { dependencies: [{ name: "target", marketplace: "market-256" }] } : {}) }));
    const renames: Record<string, string> = Object.create(null);
    for (let index = 0; index < 513; index++) renames[`chain-${String(index).padStart(4, "0")}`] = index === 512 ? "plugin-1024" : `chain-${String(index + 1).padStart(4, "0")}`;
    renames["aaa-entry-target"] = "plugin-1024";
    const userDir = writeMarketplaceState(root, catalog(plugins, { allowCrossMarketplaceDependenciesOn: allowlist, renames }));
    const result = loadPluginMarketplaceState({ userDir, projectRoot: root, seedDirs: [] });
    expect(result.dependencies[0]?.crossMarketplace).toBe("declared-allowed");
    expect(result.renames.find((item) => item.from === "aaa-entry-target")?.status).toBe("current");
    expect(result.renames.find((item) => item.from === "chain-0000")?.status).toBe("current");

    const extras = Object.fromEntries(Array.from({ length: 257 }, (_, index) => [`selected-${index}`, { source: "github", repo: `example/package-${index}` }]));
    const policy = loadPluginMarketplaceState({ userDir: path.join(root, "policy-user"), projectRoot: root, seedDirs: [], settings: settings([{ scope: "managed", sourcePath: "managed", extraKnownMarketplaces: extras, blockedMarketplaces: [{ source: "github", repo: "example/package-256" }] }]) });
    expect(policy.selectedRegistrations).toHaveLength(256);
    expect(policy.policies[0]?.match).toBe(true);
  });

  it("marks classifications indeterminate when semantic evidence itself is omitted", () => {
    const root = temporaryRoot();
    const allowlist = Array.from({ length: 2049 }, (_, index) => `market-${index}`);
    const longChain = Object.fromEntries(Array.from({ length: 2049 }, (_, index) => [`chain-${String(index).padStart(4, "0")}`, index === 2048 ? "source" : `chain-${String(index + 1).padStart(4, "0")}`]));
    const userDir = writeMarketplaceState(root, catalog([{ name: "source", source: "./source", dependencies: [{ name: "target", marketplace: "not-indexed" }] }], { allowCrossMarketplaceDependenciesOn: allowlist, renames: longChain }));
    const result = loadPluginMarketplaceState({ userDir, projectRoot: root, seedDirs: [] });
    expect(result.dependencies[0]?.crossMarketplace).toBe("indeterminate-because-evidence-omitted");
    expect(result.renames.find((item) => item.from === "chain-0000")?.status).toBe("indeterminate-because-evidence-omitted");

    const extras = Object.fromEntries(Array.from({ length: 2049 }, (_, index) => [`semantic-${index}`, { source: "github", repo: `example/semantic-${index}` }]));
    const policy = loadPluginMarketplaceState({ userDir: path.join(root, "policy"), projectRoot: root, seedDirs: [], settings: settings([{ scope: "managed", sourcePath: "managed", extraKnownMarketplaces: extras, blockedMarketplaces: [{ source: "github", repo: "example/omitted" }] }]) });
    expect(policy.policies[0]?.match).toBe("indeterminate-because-evidence-omitted");
  });

  it("applies aggregate catalog caps across multiple selected catalogs", () => {
    const root = temporaryRoot();
    const userDir = path.join(root, ".claude");
    const names = ["alpha-market", "beta-market"];
    fs.mkdirSync(path.join(userDir, "plugins"), { recursive: true });
    fs.writeFileSync(path.join(userDir, "plugins", "known_marketplaces.json"), JSON.stringify(Object.fromEntries(names.map((marketName) => [marketName, { source: { source: "github", repo: `example/${marketName}` } }]))));
    for (const marketName of names) {
      const plugins = Array.from({ length: 600 }, (_, index) => ({
        name: `plugin-${index}`, source: `./plugin-${index}`, commands: [`./command-${index}-a`, `./command-${index}-b`], dependencies: [`dependency-${index}-a`, `dependency-${index}-b`],
        metadata: { pluginRoot: `./plugin-${index}` }, userConfig: { key: "secret-value-never-retained" },
      }));
      const body = { name: marketName, owner: { name: "Owner" }, plugins, allowCrossMarketplaceDependenciesOn: Array.from({ length: 150 }, (_, index) => `allow-${index}`), renames: Object.fromEntries(Array.from({ length: 300 }, (_, index) => [`old-${index}`, `plugin-${index}`])) };
      const destination = path.join(userDir, "plugins", "marketplaces", marketName, ".claude-plugin", "marketplace.json");
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.writeFileSync(destination, JSON.stringify(body));
    }
    const result = loadPluginMarketplaceState({ userDir, projectRoot: root, seedDirs: [] });
    expect(result.entries).toHaveLength(1024);
    expect(result.dependencies).toHaveLength(1024);
    expect(result.allowlists).toHaveLength(256);
    expect(result.renames).toHaveLength(512);
    expect(result.entries.flatMap((entry) => Object.values(entry.components)).flat()).toHaveLength(1024);
    for (const key of ["entries", "components", "dependencies", "renames", "allowlists", "userConfig"] as const) expect(result.omissions[key]).toBeGreaterThan(0);
    expect(JSON.stringify(result)).not.toContain("secret-value-never-retained");
  });

  it("enforces exact byte and nesting bounds while a valid selected sibling survives", () => {
    const root = temporaryRoot();
    gitStructure(root);
    const exactPath = path.join(root, "exact.json");
    const overPath = path.join(root, "over.json");
    const deepPath = path.join(root, "deep.json");
    const prefix = '{"name":"exact-market","owner":{"name":"Owner"},"plugins":[{"name":"exact-plugin","source":"./plugin"}],"padding":"';
    const suffix = '"}';
    fs.writeFileSync(exactPath, prefix + "x".repeat(1024 * 1024 - Buffer.byteLength(prefix + suffix)) + suffix);
    fs.writeFileSync(overPath, JSON.stringify({ name: "over-market", owner: { name: "Owner" }, plugins: [] }) + " ".repeat(1024 * 1024));
    let nested: unknown = true;
    for (let index = 0; index < 33; index++) nested = [nested];
    fs.writeFileSync(deepPath, JSON.stringify({ name: "deep-market", owner: { name: "Owner" }, plugins: [], nested }));
    const result = loadPluginMarketplaceState({ userDir: path.join(root, ".claude"), projectRoot: root, seedDirs: [], settings: settings([{ scope: "project", sourcePath: "project", extraKnownMarketplaces: {
      "exact-market": { source: "file", path: "./exact.json" }, "over-market": { source: "file", path: "./over.json" }, "deep-market": { source: "file", path: "./deep.json" },
    } }]) });
    expect(fs.statSync(exactPath).size).toBe(1024 * 1024);
    expect(result.entries.map((entry) => entry.identity)).toEqual(["exact-plugin@exact-market"]);
    expect(result.diagnostics.filter((item) => item.message.includes("safe bound"))).toHaveLength(2);
  });

  it("caps seed roots and pins exact/over scalar and pattern lengths without retaining rejected values", () => {
    const root = temporaryRoot();
    const seeds = Array.from({ length: 33 }, (_, index) => path.join(root, `seed-${index}`));
    for (let index = 0; index < seeds.length; index++) {
      fs.mkdirSync(seeds[index]!, { recursive: true });
      if (index === 32) fs.writeFileSync(path.join(seeds[index]!, "known_marketplaces.json"), JSON.stringify({ omitted: { source: { source: "github", repo: "example/omitted" } } }));
    }
    const exact = "x".repeat(4096);
    const long = "x".repeat(4097);
    const result = loadPluginMarketplaceState({ userDir: path.join(root, ".claude"), projectRoot: root, seedDirs: seeds, settings: settings([{ scope: "managed", sourcePath: "managed", extraKnownMarketplaces: { exact: { source: "url", url: exact }, long: { source: "url", url: long } }, blockedMarketplaces: [{ source: "hostPattern", hostPattern: "x".repeat(513) }] }]) });
    expect(result.registrations).toHaveLength(1);
    expect(result.registrations[0]?.name).toBe("exact");
    expect(result.policies[0]).toMatchObject({ match: "indeterminate-unsupported-regex-subset", descriptor: { hostPattern: "<unsupported-regex-subset>" } });
    expect(JSON.stringify(result)).not.toContain(long);
    expect(result.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ message: expect.stringContaining("seed directories omitted") }), expect.objectContaining({ message: expect.stringContaining("unsafe source descriptor") })]));
  });

  it("bounds userConfig keys and rejects secret-bearing descriptor optionals", () => {
    const root = temporaryRoot();
    const config = Object.fromEntries(Array.from({ length: 40 }, (_, index) => [`key-${String(index).padStart(2, "0")}`, "secret-value"]));
    const userDir = writeMarketplaceState(root, catalog([
      { name: "configured", source: { source: "git-subdir", url: "https://example.test/repo", path: "plugins/item", ref: "main", sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }, userConfig: config },
      { name: "hostile", source: { source: "git-subdir", url: "https://user:secret@example.test/repo?token=x#frag", path: "plugins/item", ref: "main", sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" } },
    ]));
    const result = loadPluginMarketplaceState({ userDir, projectRoot: root, seedDirs: [] });
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.source).toEqual({ kind: "git-subdir", url: "https://example.test/repo", path: "plugins/item", ref: "main", sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" });
    expect(result.entries[0]?.userConfig).toMatchObject({ omitted: 8 });
    expect(result.entries[0]?.userConfig?.keys).toHaveLength(32);
    expect(JSON.stringify(result)).not.toMatch(/secret-value|user:secret|token=x|frag/);
  });

  it("accepts only the documented catalog source forms and requires ./ for relative strings", () => {
    const root = temporaryRoot();
    const userDir = writeMarketplaceState(root, catalog([
      { name: "relative", source: "./plugin" },
      { name: "github", source: { source: "github", repo: "owner/repo", ref: "main", sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" } },
      { name: "github-dot", source: { source: "github", repo: "owner/.github" } },
      { name: "url", source: { source: "url", url: "https://example.test/plugin", ref: "main", sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" } },
      { name: "subdir", source: { source: "git-subdir", url: "https://example.test/repo", path: "plugins/item", ref: "main", sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" } },
      { name: "subdir-shorthand", source: { source: "git-subdir", url: "owner/repo", path: "plugins/item" } },
      { name: "npm", source: { source: "npm", package: "@scope/package", version: "1.0.0", registry: "https://registry.example.test/" } },
      { name: "npm-http", source: { source: "npm", package: "@scope/pkg~helpers", registry: "http://registry.example.test/" } },
      { name: "bare-relative", source: "plugin" }, { name: "undocumented-git", source: { source: "git", url: "https://example.test/repo" } },
    ]));
    const result = loadPluginMarketplaceState({ userDir, projectRoot: root, seedDirs: [] });
    expect(result.entries.map((entry) => entry.source.kind).sort()).toEqual(["git-subdir", "git-subdir", "github", "github", "npm", "npm", "relative", "url"]);
    expect(result.entries.find((entry) => entry.name === "subdir-shorthand")?.source).toMatchObject({ url: "owner/repo" });
    expect(result.entries.find((entry) => entry.name === "github-dot")?.source).toMatchObject({ repo: "owner/.github" });
    expect(result.entries.find((entry) => entry.name === "npm-http")?.source).toMatchObject({ registry: "http://registry.example.test/" });
    expect(result.diagnostics.filter((diagnostic) => diagnostic.message.includes("undocumented"))).toHaveLength(2);
  });

  it("uses bounded regex semantics with exact length and wildcard-complexity limits", () => {
    const root = temporaryRoot();
    const exactLength = `^${"a".repeat(510)}$`;
    const overLength = `^${"a".repeat(511)}$`;
    const exactWildcards = `^${".*".repeat(16)}$`;
    const overWildcards = `^${".*".repeat(17)}$`;
    expect(exactLength).toHaveLength(512);
    expect(overLength).toHaveLength(513);
    const result = loadPluginMarketplaceState({ userDir: path.join(root, ".claude"), projectRoot: root, seedDirs: [], settings: settings([
      { scope: "user", sourcePath: "user", extraKnownMarketplaces: { official: { source: "github", repo: "owner/repo" } } },
      { scope: "managed", sourcePath: "managed", strictKnownMarketplaces: [
        { source: "hostPattern", hostPattern: "^github\\.com$" }, { source: "hostPattern", hostPattern: exactLength },
        { source: "hostPattern", hostPattern: overLength }, { source: "hostPattern", hostPattern: exactWildcards }, { source: "hostPattern", hostPattern: overWildcards },
      ] },
    ]) });
    expect(result.policies.map((policy) => [policy.descriptor !== undefined, policy.match])).toEqual([[true, true], [true, false], [true, "indeterminate-unsupported-regex-subset"], [true, true], [true, "indeterminate-unsupported-regex-subset"]]);
  });

  it("matches exact policy descriptors without URL normalization", () => {
    const root = temporaryRoot();
    const selected = { source: "url", url: "https://example.test/repo/" };
    const result = loadPluginMarketplaceState({ userDir: path.join(root, ".claude"), projectRoot: root, seedDirs: [], settings: settings([
      { scope: "user", sourcePath: "user", extraKnownMarketplaces: { official: selected } },
      { scope: "managed", sourcePath: "managed", blockedMarketplaces: [
        selected, { source: "url", url: "https://example.test/repo" }, { source: "git", url: "https://example.test/repo/" }, { source: "url", url: "git@example.test:repo" },
        { source: "url", url: "https://EXAMPLE.test/repo/" }, { source: "url", url: "https://example.test:443/repo/" },
      ] },
    ]) });
    expect(result.policies.map((policy) => policy.match)).toEqual([true, false, false, false, false, false]);
  });

  it("revalidates normalized settings observations instead of trusting forged validity", () => {
    const root = temporaryRoot();
    const forgedCredential = {
      validity: "valid", matchKey: "forged",
      descriptor: { kind: "url", url: "https://user:forged-secret@example.test/catalog?token=forged-token" },
    };
    const forgedArbitrary = {
      validity: "valid", matchKey: "forged", arbitrary: "forged-arbitrary-canary",
      descriptor: { kind: "url", url: "https://example.test/catalog", injected: "forged-field" },
    };
    const result = loadPluginMarketplaceState({ userDir: path.join(root, ".claude"), projectRoot: root, seedDirs: [], settings: {
      pluginMarketplaceSettings: [{ scope: "user", sourcePath: "user", extraKnownMarketplaces: { credential: forgedCredential, arbitrary: forgedArbitrary } }],
    } });
    expect(result.registrations).toEqual([expect.objectContaining({ name: "credential", source: { kind: "url", url: "<redacted-url>" }, validity: "rejected" })]);
    expect(JSON.stringify(result)).not.toMatch(/forged-secret|forged-token|forged-arbitrary-canary|forged-field/);
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ message: expect.stringContaining("invalid name or nested source descriptor") }));

    const key = (repo: string): string => JSON.stringify({ kind: "github", repo });
    const registrationRecomputed = loadPluginMarketplaceState({ userDir: path.join(root, ".claude"), projectRoot: root, seedDirs: [], settings: {
      pluginMarketplaceSettings: [
        { scope: "user", sourcePath: "user", extraKnownMarketplaces: { selected: { validity: "valid", matchKey: key("owner/beta"), descriptor: { kind: "github", repo: "owner/alpha" } } } },
        { scope: "managed", sourcePath: "managed", blockedMarketplaces: [{ source: "github", repo: "owner/alpha" }] },
      ],
    } });
    expect(registrationRecomputed.policies[0]?.match).toBe(true);

    const forgedPolicySecret = "forged-policy-secret";
    const policyRecomputed = loadPluginMarketplaceState({ userDir: path.join(root, ".claude"), projectRoot: root, seedDirs: [], settings: {
      pluginMarketplaceSettings: [
        { scope: "user", sourcePath: "user", extraKnownMarketplaces: { selected: { source: { source: "github", repo: "owner/alpha" } } } },
        { scope: "managed", sourcePath: "managed", blockedMarketplaces: [
          { validity: "valid", matchKey: key("owner/alpha"), descriptor: { kind: "github", repo: "owner/beta" } },
          { validity: "valid", matchKey: key("owner/beta"), descriptor: { kind: "github", repo: "owner/alpha" } },
          { validity: "valid", matchKey: key("owner/alpha"), descriptor: { kind: "url", url: `https://user:${forgedPolicySecret}@example.test/catalog?token=hidden` } },
        ] },
      ],
    } });
    expect(policyRecomputed.policies.map((policy) => policy.match)).toEqual([false, true, "indeterminate-redacted-descriptor"]);
    expect(JSON.stringify(policyRecomputed)).not.toMatch(/forged-policy-secret|token=hidden/);
    expect(policyRecomputed.policies[2]).toMatchObject({ descriptor: { kind: "url", url: "<redacted-url>" }, validScope: true });

    const forgedValidityRegistrationSecret = "forged-validity-registration-secret";
    const forgedValidityPolicySecret = "forged-validity-policy-secret";
    const forgedValidity = loadPluginMarketplaceState({ userDir: path.join(root, ".claude"), projectRoot: root, seedDirs: [], settings: {
      pluginMarketplaceSettings: [
        { scope: "user", sourcePath: "user", extraKnownMarketplaces: {
          selected: { source: { source: "github", repo: "owner/alpha" } },
          forged: { validity: "forged", descriptor: { kind: "url", url: `https://user:${forgedValidityRegistrationSecret}@example.test/catalog` } } as never,
        } },
        { scope: "managed", sourcePath: "managed", blockedMarketplaces: [
          { validity: "forged", descriptor: { kind: "url", url: `https://user:${forgedValidityPolicySecret}@example.test/catalog` } } as never,
        ] },
      ],
    } });
    expect(forgedValidity.selectedRegistrations.map((registration) => registration.name)).toEqual(["selected"]);
    expect(forgedValidity.registrations.some((registration) => registration.name === "forged")).toBe(false);
    expect(forgedValidity.policies).toEqual([expect.objectContaining({ match: false })]);
    expect(JSON.stringify(forgedValidity)).not.toMatch(/forged-validity-registration-secret|forged-validity-policy-secret/);
  });

  it("makes invalid-scope policy inert before unsupported-pattern classification", () => {
    const root = temporaryRoot();
    const result = loadPluginMarketplaceState({ userDir: path.join(root, ".claude"), projectRoot: root, seedDirs: [], settings: settings([
      { scope: "project", sourcePath: "project", strictKnownMarketplaces: [{ source: "hostPattern", hostPattern: "(" }] },
      { scope: "local", sourcePath: "local", blockedMarketplaces: [{ source: "pathPattern", pathPattern: "x".repeat(513) }] },
    ]) });
    expect(result.policies).toEqual(expect.arrayContaining([
      expect.objectContaining({ validScope: false, match: false, descriptor: { kind: "hostPattern", hostPattern: "<unsupported-regex-subset>" } }),
      expect.objectContaining({ validScope: false, match: false, descriptor: { kind: "pathPattern", pathPattern: "<unsupported-regex-subset>" } }),
    ]));
    expect(result.diagnostics).toHaveLength(2);
  });

  it("extracts hosts from documented SCP git sources for host patterns", () => {
    const root = temporaryRoot();
    const result = loadPluginMarketplaceState({ userDir: path.join(root, ".claude"), projectRoot: root, seedDirs: [], settings: settings([
      { scope: "user", sourcePath: "user", extraKnownMarketplaces: { scp: { source: "git", url: "git@Git.Example.test:owner/repo.git" } } },
      { scope: "managed", sourcePath: "managed", blockedMarketplaces: [
        { source: "hostPattern", hostPattern: "^Git\\.Example\\.test$" },
        { source: "hostPattern", hostPattern: "^git\\.example\\.test$" },
      ] },
    ]) });
    expect(result.policies.map((policy) => policy.match)).toEqual([true, false]);
  });

  it("keeps exact policy outcomes indeterminate when credential-bearing registration evidence was redacted", () => {
    const root = temporaryRoot();
    const result = loadPluginMarketplaceState({ userDir: path.join(root, ".claude"), projectRoot: root, seedDirs: [], settings: settings([
      { scope: "user", sourcePath: "user", extraKnownMarketplaces: { ambiguous: { source: "url", url: "https://user:registration-secret@example.test/catalog?token=x" } } },
      { scope: "managed", sourcePath: "managed", blockedMarketplaces: [{ source: "url", url: "https://example.test/other" }] },
    ]) });
    expect(result.policies[0]).toMatchObject({ match: "indeterminate-redacted-descriptor", validScope: true });
    expect(JSON.stringify(result)).not.toContain("registration-secret");
  });

  it("redacts opaque and scp-like credentials in every descriptor context", () => {
    const root = temporaryRoot();
    const canaries = ["foo:user:registration-canary@host/path", "git:user:policy-canary@host/path", "custom:user:catalog-canary@host/path"];
    const userDir = writeMarketplaceState(root, catalog([{ name: "secret-source", source: { source: "url", url: canaries[2] } }]));
    const result = loadPluginMarketplaceState({ userDir, projectRoot: root, seedDirs: [], settings: settings([
      { scope: "user", sourcePath: "user", extraKnownMarketplaces: { secret: { source: "url", url: canaries[0] }, safe: { source: "git", url: "git@example.test:owner/repo" } } },
      { scope: "managed", sourcePath: "managed", blockedMarketplaces: [{ source: "git", url: canaries[1] }] },
    ]) });
    const serialized = JSON.stringify(result);
    for (const canary of canaries) expect(serialized).not.toContain(canary.split(":")[2]!.split("@")[0]);
    expect(serialized).toContain("git@example.test:owner/repo");
  });

  it("isolates malformed catalog source syntax and removes every option canary", () => {
    const root = temporaryRoot();
    const sha = "a".repeat(40);
    const plugins = [
      { name: "safe", source: { source: "github", repo: "Owner/Repo", ref: "release-1", sha } },
      { name: "github-shape", source: { source: "github", repo: "owner" } },
      { name: "short-sha", source: { source: "github", repo: "owner/repo", sha: "short-sha-canary" } },
      { name: "ref-url", source: { source: "github", repo: "owner/repo", ref: "https://user:ref-canary@example.test/x?token=x" } },
      { name: "url-secret", source: { source: "url", url: "https://user:url-canary@example.test/x?token=x#frag" } },
      { name: "subdir-traversal", source: { source: "git-subdir", url: "git@example.test:owner/repo", path: "../path-canary" } },
      { name: "subdir-shorthand-traversal", source: { source: "git-subdir", url: "owner/../repo", path: "plugins/item" } },
      { name: "npm-version", source: { source: "npm", package: "safe-package", version: "https://version-canary.example/x" } },
      { name: "npm-registry", source: { source: "npm", package: "safe-package", registry: "http://user:registry-canary@example.test/?token=x#frag" } },
    ];
    const userDir = writeMarketplaceState(root, catalog(plugins));
    const result = loadPluginMarketplaceState({ userDir, projectRoot: root, seedDirs: [] });
    expect(result.entries.map((entry) => entry.name)).toEqual(["safe"]);
    expect(JSON.stringify(result)).not.toMatch(/short-sha-canary|ref-canary|url-canary|path-canary|version-canary|registry-canary|token=x/);
    expect(result.diagnostics.filter((diagnostic) => diagnostic.message.includes("source descriptor"))).toHaveLength(plugins.length - 1);
  });

  it("records top-level pluginRoot provenance and its inert relative-source effect", () => {
    const root = temporaryRoot();
    const body = catalog([{ name: "relative", source: "./plugin" }, { name: "bare", source: "formatter" }], { metadata: { pluginRoot: "./bundle" } });
    const userDir = writeMarketplaceState(root, body, { source: "url", url: "https://example.test/catalog.json" });
    const result = loadPluginMarketplaceState({ userDir, projectRoot: root, seedDirs: [] });
    expect(result.catalogs[0]?.metadata).toMatchObject({ pluginRoot: "./bundle", provenance: { field: "metadata.pluginRoot" } });
    expect(result.entries.find((entry) => entry.name === "relative")?.sourceEffect).toMatchObject({ availability: "unavailable-from-direct-url-catalog", provenance: { field: "source", entryIndex: 0 } });
    expect(result.entries.find((entry) => entry.name === "bare")).toMatchObject({ source: { kind: "relative", value: "formatter" }, sourceEffect: { lexicalPath: "bundle/formatter" } });
    expect(result.entries[0]).not.toHaveProperty("metadata");

    const withoutRoot = writeMarketplaceState(temporaryRoot(), catalog([{ name: "bare", source: "formatter" }]));
    expect(loadPluginMarketplaceState({ userDir: withoutRoot, projectRoot: root, seedDirs: [] }).entries).toEqual([]);
  });

  it("classifies inline component objects without retaining command or config values", () => {
    const root = temporaryRoot();
    const userDir = writeMarketplaceState(root, catalog([{ name: "inline", source: "./plugin", hooks: { command: "component-command-canary", matcher: "*" }, mcpServers: { secret: "component-config-canary" }, lspServers: "./lsp.json" }]));
    const result = loadPluginMarketplaceState({ userDir, projectRoot: root, seedDirs: [] });
    expect(result.entries[0]?.components).toMatchObject({
      hooks: [{ kind: "object-shape", shape: { keys: [{ key: "command", type: "string" }, { key: "matcher", type: "string" }] }, provenance: { field: "hooks" }, posture: "declared-not-effective" }],
      mcpServers: [{ kind: "object-shape", provenance: { field: "mcpServers" } }], lspServers: [{ kind: "path", value: "./lsp.json" }],
    });
    expect(JSON.stringify(result)).not.toMatch(/component-command-canary|component-config-canary/);
  });

  it("retains only portable component paths while isolating string and object array siblings", () => {
    const root = temporaryRoot();
    const unsafe = ["skill", "../escape", "/absolute", "C:/device", "\\\\server\\share", "https://user:secret@example.test/x", "./query?secret=x", "./fragment#x", "./control\u0001"];
    const userDir = writeMarketplaceState(root, catalog([{
      name: "components", source: "./plugin",
      skills: ["./safe-skill", ...unsafe, 42],
      hooks: ["./safe-hook.json", { command: "component-command-secret", env: { TOKEN: "component-config-secret" } }, "../bad-hook"],
      mcpServers: [{ command: "server-secret" }, "./mcp.json"],
      lspServers: ["./lsp.json", null],
    }]));
    const result = loadPluginMarketplaceState({ userDir, projectRoot: root, seedDirs: [] });
    const components = result.entries[0]!.components;
    expect(components.skills).toEqual([expect.objectContaining({ kind: "path", value: "./safe-skill", provenance: expect.objectContaining({ itemIndex: 0 }) })]);
    expect(components.hooks).toEqual([
      expect.objectContaining({ kind: "path", value: "./safe-hook.json", provenance: expect.objectContaining({ itemIndex: 0 }) }),
      expect.objectContaining({ kind: "object-shape", provenance: expect.objectContaining({ itemIndex: 1 }) }),
    ]);
    expect(components.mcpServers).toHaveLength(2);
    expect(components.lspServers).toHaveLength(1);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toMatch(/user:secret|component-command-secret|component-config-secret|server-secret/);
    expect(result.diagnostics.filter((diagnostic) => diagnostic.message.includes("portable ./"))).toHaveLength(unsafe.length + 3);
  });

  it("provides exact decision-ready provenance for every retained catalog field", () => {
    const root = temporaryRoot();
    const userDir = writeMarketplaceState(root, catalog([{ name: "complete", source: { source: "github", repo: "owner/repo", sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }, version: "1", revision: "fixture-rev", description: "description", strict: false, defaultEnabled: true, skills: ["./skill"], dependencies: [{ name: "dep", version: "not-checked" }], userConfig: { mode: "secret" } }], { metadata: { pluginRoot: "./root" }, allowCrossMarketplaceDependenciesOn: ["partner"], renames: { constructor: "complete" } }));
    const result = loadPluginMarketplaceState({ userDir, projectRoot: root, seedDirs: [] });
    const sourcePath = result.selectedRegistrations[0]!.catalogPath!;
    expect(result.entries[0]?.fieldProvenance).toEqual({
      source: { field: "source", sourcePath, entryIndex: 0 }, description: { field: "description", sourcePath, entryIndex: 0 }, version: { field: "version", sourcePath, entryIndex: 0 },
      revision: { field: "revision", sourcePath, entryIndex: 0 }, "source.sha": { field: "source.sha", sourcePath, entryIndex: 0 }, strict: { field: "strict", sourcePath, entryIndex: 0 }, defaultEnabled: { field: "defaultEnabled", sourcePath, entryIndex: 0 },
    });
    expect(result.entries[0]?.defaultEnabledDeclaration).toEqual({ value: true, presence: "explicit", provenance: { field: "defaultEnabled", sourcePath, entryIndex: 0 } });
    expect(result.entries[0]).toMatchObject({
      revisionEvidence: "fixture-derived-unverified", userConfig: { provenance: { field: "userConfig", sourcePath, entryIndex: 0 } },
      components: { skills: [{ provenance: { field: "skills", sourcePath, entryIndex: 0, itemIndex: 0 } }] },
      dependencies: [{ provenance: { field: "dependencies", sourcePath, entryIndex: 0, itemIndex: 0 }, versionStatus: "syntax-unverified-not-resolved" }],
    });
    expect(result.allowlists[0]?.provenance).toEqual({ field: "allowCrossMarketplaceDependenciesOn", sourcePath, itemIndex: 0 });
    expect(result.catalogs[0]?.metadata?.provenance).toEqual({ field: "metadata.pluginRoot", sourcePath });
    expect(result.renames[0]?.from).toBe("constructor");
    expect(result.renames[0]?.fieldProvenance).toEqual({ field: "renames", sourcePath, key: "constructor" });
  });

  it("does not let malformed or canonically rejected later settings displace valid evidence", () => {
    const root = temporaryRoot();
    gitStructure(root);
    const result = loadPluginMarketplaceState({ userDir: path.join(root, ".claude"), projectRoot: root, seedDirs: [], settings: settings([
      { scope: "user", sourcePath: "earlier", extraKnownMarketplaces: { shared: { source: "github", repo: "owner/earlier" } } },
      { scope: "project", sourcePath: "missing", extraKnownMarketplaces: { shared: { source: "directory", path: "./missing" } } },
      { scope: "managed", sourcePath: "malformed", extraKnownMarketplaces: { shared: { source: "github" } } },
    ]) });
    expect(result.selectedRegistrations[0]).toMatchObject({ source: { kind: "github", repo: "owner/earlier" }, provenance: { sourcePath: "earlier" }, validity: "valid" });
    expect(result.registrations).toContainEqual(expect.objectContaining({ provenance: expect.objectContaining({ sourcePath: "missing" }), validity: "rejected", selected: false }));
  });

  it("treats omissions from loadSettings as indeterminate policy evidence", () => {
    const root = temporaryRoot();
    const userDir = path.join(root, ".claude");
    fs.mkdirSync(userDir, { recursive: true });
    fs.writeFileSync(path.join(userDir, "settings.json"), JSON.stringify({ extraKnownMarketplaces: Object.fromEntries(Array.from({ length: 257 }, (_, index) => [`market-${index}`, { source: { source: "github", repo: `owner/repo-${index}` } }])) }));
    const loaded = loadSettings({ cwd: root, projectRoot: root, userDir, managedPaths: [] });
    loaded.pluginMarketplaceSettings?.push({ scope: "managed", sourcePath: "captured-managed", blockedMarketplaces: [normalizeMarketplacePolicyDescriptor({ source: "github", repo: "owner/not-captured" })] });
    const result = loadPluginMarketplaceState({ userDir, projectRoot: root, seedDirs: [], settings: loaded });
    expect(loaded.pluginMarketplaceSettingsOmissions?.declarations).toBeGreaterThan(0);
    expect(result.policies[0]?.match).toBe("indeterminate-because-evidence-omitted");
    const managedPaths = Array.from({ length: 257 }, (_, index) => path.join(root, `managed-${index}.json`));
    for (const managedPath of managedPaths) fs.writeFileSync(managedPath, JSON.stringify({ extraKnownMarketplaces: {} }));
    const emptyProject = path.join(root, "empty-project");
    fs.mkdirSync(emptyProject);
    const contributionCapped = loadSettings({ cwd: emptyProject, projectRoot: emptyProject, userDir: path.join(root, "empty-user"), managedPaths });
    contributionCapped.pluginMarketplaceSettings?.push({ scope: "managed", sourcePath: "captured-managed", blockedMarketplaces: [normalizeMarketplacePolicyDescriptor({ source: "github", repo: "owner/not-captured" })] });
    const contributionOmitted = loadPluginMarketplaceState({ userDir, projectRoot: root, seedDirs: [], settings: contributionCapped });
    expect(contributionCapped.pluginMarketplaceSettingsOmissions).toEqual({ contributions: 1, declarations: 0 });
    expect(contributionOmitted.policies[0]?.match).toBe("indeterminate-because-evidence-omitted");
  });

  it("isolates malformed registration, entry, rename, and prototype-key siblings", () => {
    const root = temporaryRoot();
    const userDir = path.join(root, ".claude");
    fs.mkdirSync(path.join(userDir, "plugins"), { recursive: true });
    fs.writeFileSync(path.join(userDir, "plugins", "known_marketplaces.json"), '{"__proto__":{},"bad_entry":null,"broken-marketplace":null,"official-marketplace":{"source":{"source":"github","repo":"owner/repo"}}}');
    const catalogPath = path.join(userDir, "plugins", "marketplaces", "official-marketplace", ".claude-plugin", "marketplace.json");
    fs.mkdirSync(path.dirname(catalogPath), { recursive: true });
    fs.writeFileSync(catalogPath, '{"name":"official-marketplace","owner":{"name":"Example"},"plugins":[{"name":"safe","source":"./safe"},null,{"name":"bad_name","source":"./bad"}],"renames":{"bad_name":{},"old":"safe","constructor":"safe","__proto__":"safe"}}');
    const result = loadPluginMarketplaceState({ userDir, projectRoot: root, seedDirs: [] });
    expect(result.entries.map((entry) => entry.name)).toEqual(["safe"]);
    expect(result.renames).toContainEqual(expect.objectContaining({ from: "old", status: "current" }));
    expect(result.renames).toContainEqual(expect.objectContaining({ from: "constructor", status: "current", fieldProvenance: expect.objectContaining({ key: "constructor" }) }));
    expect(result.renames.some((rename) => rename.from === "__proto__")).toBe(false);
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ message: expect.stringContaining("malformed rename") }));
    expect(result.diagnostics.length).toBeGreaterThanOrEqual(4);
  });
});

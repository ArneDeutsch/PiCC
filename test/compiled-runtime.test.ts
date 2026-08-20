import { createHash } from "node:crypto";
import { execFileSync, spawnSync as realSpawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildRuntime } from "../scripts/build-runtime.mjs";
import { selectPiccRuntime, verifyCompiledRuntime } from "../bin/picc-runtime.mjs";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
let fixtureRoot = "";

type RecordEntry = { path: string; sha256: string };
type RuntimeManifest = {
  schemaVersion: number;
  package: { name: string; version: string; type: string };
  compiler: {
    typescriptVersion: string;
    configPath: string;
    configSha256: string;
    dependencyLockPath: string;
    dependencyLockSha256: string;
  };
  sources: RecordEntry[];
  sourceDigest: string;
  files: RecordEntry[];
  runtimeDigest: string;
  entries: { extension: string; pluginInventory: string; mcpAdministration: string };
};

function digest(value: unknown): string {
  return createHash("sha256").update(Buffer.from(JSON.stringify(value), "utf8")).digest("hex");
}

function hashFile(file: string): string {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function writeFixture(): void {
  fixtureRoot = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "picc runtime path with spaces ")));
  fs.writeFileSync(path.join(fixtureRoot, "package.json"), JSON.stringify({ name: "@arnedeutsch/picc", version: "0.1.1", type: "module" }));
  fs.writeFileSync(path.join(fixtureRoot, "package-lock.json"), '{"lockfileVersion":3}\n');
  fs.mkdirSync(path.join(fixtureRoot, "src", "nested"), { recursive: true });
  fs.writeFileSync(path.join(fixtureRoot, "src", "index.ts"), 'export default function mappedWitness(): never { throw new Error("mapped witness"); }\n');
  fs.writeFileSync(path.join(fixtureRoot, "src", "plugin-inventory-cli.ts"), "export const inventory = true;\n");
  fs.writeFileSync(path.join(fixtureRoot, "src", "mcp-administration-cli.ts"), "export const mcpAdministration = true;\n");
  fs.writeFileSync(path.join(fixtureRoot, "src", "nested", "café.ts"), "export const café = true;\n");
  fs.writeFileSync(path.join(fixtureRoot, "unrelated.txt"), "not a compiler input\n");
  fs.copyFileSync(path.join(repositoryRoot, "tsconfig.runtime.json"), path.join(fixtureRoot, "tsconfig.runtime.json"));
  const config = JSON.parse(fs.readFileSync(path.join(fixtureRoot, "tsconfig.runtime.json"), "utf8")) as { compilerOptions: { types: string[] } };
  config.compilerOptions.types = [];
  fs.writeFileSync(path.join(fixtureRoot, "tsconfig.runtime.json"), `${JSON.stringify(config, null, 2)}\n`);
  fs.mkdirSync(path.join(fixtureRoot, "picc"));
  fs.copyFileSync(path.join(repositoryRoot, "picc", "index.ts"), path.join(fixtureRoot, "picc", "index.ts"));
  fs.mkdirSync(path.join(fixtureRoot, "bin"));
  fs.copyFileSync(path.join(repositoryRoot, "bin", "picc-runtime.mjs"), path.join(fixtureRoot, "bin", "picc-runtime.mjs"));
  fs.symlinkSync(path.join(repositoryRoot, "node_modules"), path.join(fixtureRoot, "node_modules"), "junction");
  buildRuntime({ packageRoot: fixtureRoot });
}

function manifest(): RuntimeManifest {
  return JSON.parse(fs.readFileSync(path.join(fixtureRoot, "dist", "picc-runtime.json"), "utf8")) as RuntimeManifest;
}

function rewriteManifest(mutator: (value: RuntimeManifest) => void, repairDigests = false): RuntimeManifest {
  const value = manifest();
  mutator(value);
  if (repairDigests) {
    value.sourceDigest = digest({ package: value.package, compiler: value.compiler, sources: value.sources });
    value.runtimeDigest = digest(value.files);
  }
  fs.writeFileSync(path.join(fixtureRoot, "dist", "picc-runtime.json"), `${JSON.stringify(value, null, 2)}\n`);
  return value;
}

function expectFailure(result: unknown, category: "missing" | "source-stale" | "corrupt" | "version-mismatch"): void {
  expect(result).toStrictEqual({ ok: false, category, reason: expect.any(String) });
}

function expectNeutralStartupContextMismatch(result: unknown): void {
  expect(result).toStrictEqual({ ok: false, category: "corrupt", reason: expect.any(String) });
  const reason = (result as { reason: string }).reason;
  expect(reason).toMatch(/startup context.*exit.*relaunch/isu);
  expect(reason.length).toBeLessThan(200);
  expect(reason).not.toMatch(/damag|build|updat|version|repair|reinstall|selection|authority|authentic|loader|provenance|evidence|digest|identity key|host graph|pending|retained|handoff|internal/iu);
}

function runIsolatedRuntime(body: string, roots: Record<string, string> = { fixtureRoot }): unknown {
  const runtimeUrl = pathToFileURL(path.join(repositoryRoot, "bin", "picc-runtime.mjs")).href;
  const source = `
    import fs from "node:fs";
    import { pathToFileURL } from "node:url";
    const runtimeUrl = ${JSON.stringify(runtimeUrl)};
    const runtime = await import(runtimeUrl + ${JSON.stringify(`?isolated=${Date.now()}-${Math.random()}`)});
    const roots = ${JSON.stringify(roots)};
    ${body}
  `;
  return JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", source], { encoding: "utf8" })) as unknown;
}

function expectVerified(checkSource = true): RuntimeManifest {
  const expectedManifest = manifest();
  expect(verifyCompiledRuntime({ packageRoot: fixtureRoot, checkSource })).toStrictEqual({
    ok: true,
    manifest: expectedManifest,
    entries: { extensionPath: "picc/index.ts", pluginInventoryPath: "dist/plugin-inventory-cli.js", mcpAdministrationPath: "dist/mcp-administration-cli.js" },
  });
  return expectedManifest;
}

function config(): { compilerOptions: Record<string, unknown>; include: string[]; exclude: string[]; [key: string]: unknown } {
  return JSON.parse(fs.readFileSync(path.join(fixtureRoot, "tsconfig.runtime.json"), "utf8")) as ReturnType<typeof config>;
}

function writeConfig(value: ReturnType<typeof config>): void {
  fs.writeFileSync(path.join(fixtureRoot, "tsconfig.runtime.json"), `${JSON.stringify(value, null, 2)}\n`);
}

function symlinkFileCase(relativePath: string, assertion: () => void): void {
  const target = path.join(fixtureRoot, relativePath);
  const saved = `${target}.saved`;
  fs.renameSync(target, saved);
  try {
    try {
      fs.symlinkSync(saved, target, "file");
      assertion();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error;
      const realLstat = fs.lstatSync;
      const linkedStat = Object.create(realLstat(saved)) as fs.Stats;
      linkedStat.isSymbolicLink = () => true;
      vi.spyOn(fs, "lstatSync").mockImplementation(((candidate: fs.PathLike, ...args: unknown[]) => (
        path.resolve(String(candidate)) === target ? linkedStat : realLstat(candidate, ...(args as []))
      )) as typeof fs.lstatSync);
      assertion();
      vi.restoreAllMocks();
    }
  } finally {
    fs.rmSync(target, { force: true });
    fs.renameSync(saved, target);
  }
}

beforeEach(() => {
  writeFixture();
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
});

describe("compiled runtime identity", () => {
  it("emits only JavaScript, external maps, and deterministic dependency-bound identity", () => {
    const first = manifest();
    const firstBytes = fs.readFileSync(path.join(fixtureRoot, "dist", "picc-runtime.json"), "utf8");
    const outputs = fs.readdirSync(path.join(fixtureRoot, "dist"), { recursive: true })
      .map(String)
      .map((entry) => entry.replaceAll("\\", "/"))
      .filter((entry) => fs.statSync(path.join(fixtureRoot, "dist", ...entry.split("/"))).isFile())
      .sort();
    expect(outputs).toStrictEqual([
      "index.js", "index.js.map", "mcp-administration-cli.js", "mcp-administration-cli.js.map", "nested/café.js", "nested/café.js.map", "picc-runtime.json",
      "plugin-inventory-cli.js", "plugin-inventory-cli.js.map",
    ]);
    expect(fs.readFileSync(path.join(fixtureRoot, "dist", "index.js"), "utf8")).toContain("function mappedWitness()");
    const packageJson = JSON.parse(fs.readFileSync(path.join(fixtureRoot, "package.json"), "utf8")) as Record<string, string>;
    const typescriptPackage = JSON.parse(fs.readFileSync(path.join(fixtureRoot, "node_modules", "typescript", "package.json"), "utf8")) as { version: string };
    const canonicalPackage = { name: packageJson.name!, version: packageJson.version!, type: packageJson.type! };
    const canonicalCompiler = {
      typescriptVersion: typescriptPackage.version,
      configPath: "tsconfig.runtime.json",
      configSha256: hashFile(path.join(fixtureRoot, "tsconfig.runtime.json")),
      dependencyLockPath: "package-lock.json",
      dependencyLockSha256: hashFile(path.join(fixtureRoot, "package-lock.json")),
    };
    const canonicalSources = ["src/index.ts", "src/mcp-administration-cli.ts", "src/nested/café.ts", "src/plugin-inventory-cli.ts"]
      .map((recordPath) => ({ path: recordPath, sha256: hashFile(path.join(fixtureRoot, ...recordPath.split("/"))) }));
    const canonicalFiles = [
      "dist/index.js", "dist/index.js.map", "dist/mcp-administration-cli.js", "dist/mcp-administration-cli.js.map", "dist/nested/café.js", "dist/nested/café.js.map",
      "dist/plugin-inventory-cli.js", "dist/plugin-inventory-cli.js.map", "picc/index.ts",
    ].map((recordPath) => ({ path: recordPath, sha256: hashFile(path.join(fixtureRoot, ...recordPath.split("/"))) }));
    expect(first.package).toStrictEqual(canonicalPackage);
    expect(first.compiler).toStrictEqual(canonicalCompiler);
    expect(first.sources).toStrictEqual(canonicalSources);
    expect(first.files).toStrictEqual(canonicalFiles);
    expect(first.sourceDigest).toBe(digest({ package: canonicalPackage, compiler: canonicalCompiler, sources: canonicalSources }));
    expect(first.runtimeDigest).toBe(digest(canonicalFiles));
    expectVerified();
    buildRuntime({ packageRoot: fixtureRoot });
    expect(fs.readFileSync(path.join(fixtureRoot, "dist", "picc-runtime.json"), "utf8")).toBe(firstBytes);
  });

  it("pins independently serialized source and runtime digest known vectors", () => {
    const packageIdentity = { name: "@arnedeutsch/picc", version: "1.2.3", type: "module" };
    const compiler = {
      typescriptVersion: "7.0.2", configPath: "tsconfig.runtime.json", configSha256: "0".repeat(64),
      dependencyLockPath: "package-lock.json", dependencyLockSha256: "a".repeat(64),
    };
    const sources = [{ path: "src/index.ts", sha256: "1".repeat(64) }];
    const files = [
      { path: "dist/index.js", sha256: "2".repeat(64) },
      { path: "picc/index.ts", sha256: "3".repeat(64) },
    ];
    expect(digest({ package: packageIdentity, compiler, sources })).toBe("eed003bd1c6c2ccd6695227e890208a2ec3c5268b08f0b96d4566fe6fd438464");
    expect(digest(files)).toBe("434689296a605ecc5818fa61861f276e8978c5c9a70a9d2dcb6860e6c069c770");
  });

  it("invalidates add, change, delete, and rename source mutations but ignores unrelated files", () => {
    fs.writeFileSync(path.join(fixtureRoot, "unrelated.txt"), "changed\n");
    expectVerified();
    const source = path.join(fixtureRoot, "src", "plugin-inventory-cli.ts");
    const original = fs.readFileSync(source);
    const mutations: Array<() => () => void> = [
      () => { const added = path.join(fixtureRoot, "src", "added.ts"); fs.writeFileSync(added, "export {};\n"); return () => fs.rmSync(added); },
      () => { fs.appendFileSync(source, "// drift\n"); return () => fs.writeFileSync(source, original); },
      () => { fs.rmSync(source); return () => fs.writeFileSync(source, original); },
      () => { const renamed = path.join(fixtureRoot, "src", "renamed.ts"); fs.renameSync(source, renamed); return () => fs.renameSync(renamed, source); },
    ];
    for (const mutate of mutations) {
      const restore = mutate();
      try {
        expectFailure(verifyCompiledRuntime({ packageRoot: fixtureRoot, checkSource: true }), "source-stale");
        expectVerified(false);
      } finally {
        restore();
      }
      expectVerified();
    }
  });

  it("classifies package identity drift by installation mode with corruption taking precedence", () => {
    const packagePath = path.join(fixtureRoot, "package.json");
    const original = fs.readFileSync(packagePath);
    for (const [key, changed] of [["name", "other"], ["version", "0.2.0"], ["type", "commonjs"]] as const) {
      const value = JSON.parse(original.toString("utf8")) as Record<string, string>;
      value[key] = changed;
      fs.writeFileSync(packagePath, JSON.stringify(value));
      expectFailure(verifyCompiledRuntime({ packageRoot: fixtureRoot, checkSource: false }), "version-mismatch");
      expectFailure(verifyCompiledRuntime({ packageRoot: fixtureRoot, checkSource: true }), "source-stale");
    }
    fs.writeFileSync(packagePath, original);
    fs.appendFileSync(path.join(fixtureRoot, "dist", "index.js"), "// corrupt\n");
    fs.writeFileSync(packagePath, JSON.stringify({ name: "other", version: "9.9.9", type: "commonjs" }));
    expectFailure(verifyCompiledRuntime({ packageRoot: fixtureRoot, checkSource: false }), "corrupt");
    expectFailure(verifyCompiledRuntime({ packageRoot: fixtureRoot, checkSource: true }), "corrupt");
  });

  it("binds dependency-lock bytes, TypeScript version, and config bytes only for source checks", () => {
    fs.appendFileSync(path.join(fixtureRoot, "package-lock.json"), " ");
    expectFailure(verifyCompiledRuntime({ packageRoot: fixtureRoot, checkSource: true }), "source-stale");
    expectVerified(false);
    buildRuntime({ packageRoot: fixtureRoot });

    rewriteManifest((value) => { value.compiler.typescriptVersion = "0.0.0-test"; }, true);
    expectFailure(verifyCompiledRuntime({ packageRoot: fixtureRoot, checkSource: true }), "source-stale");
    expectVerified(false);
    buildRuntime({ packageRoot: fixtureRoot });

    const changed = config();
    changed.compilerOptions.types = ["node"];
    writeConfig(changed);
    expectFailure(verifyCompiledRuntime({ packageRoot: fixtureRoot, checkSource: true }), "source-stale");
    expectVerified(false);
  });

  it.each([
    ["module", "ESNext"], ["moduleResolution", "Bundler"], ["resolveJsonModule", true], ["allowJs", true],
    ["checkJs", true], ["inlineSourceMap", true], ["inlineSources", true], ["sourceMap", false],
  ] as const)("rejects non-runtime compiler option %s=%j", (key, changed) => {
    const value = config();
    value.compilerOptions[key] = changed;
    writeConfig(value);
    expectFailure(verifyCompiledRuntime({ packageRoot: fixtureRoot, checkSource: true }), "source-stale");
    expect(() => buildRuntime({ packageRoot: fixtureRoot })).toThrow(/compiler options/u);
  });

  it.each([
    ["extends", "./base.json"], ["references", []], ["files", ["src/index.ts"]], ["compileOnSave", true],
  ] as const)("rejects runtime config composition key %s", (key, changed) => {
    const value = config();
    value[key] = changed;
    writeConfig(value);
    expectFailure(verifyCompiledRuntime({ packageRoot: fixtureRoot, checkSource: true }), "source-stale");
    expect(() => buildRuntime({ packageRoot: fixtureRoot })).toThrow(/config shape/u);
  });

  it("rejects malformed and unknown schemas, missing trees, and internal digest corruption with exact unions", () => {
    const dist = path.join(fixtureRoot, "dist");
    const saved = path.join(fixtureRoot, "saved dist");
    fs.renameSync(dist, saved);
    expectFailure(verifyCompiledRuntime({ packageRoot: fixtureRoot }), "missing");
    fs.renameSync(saved, dist);
    fs.rmSync(path.join(dist, "picc-runtime.json"));
    expectFailure(verifyCompiledRuntime({ packageRoot: fixtureRoot }), "missing");
    buildRuntime({ packageRoot: fixtureRoot });
    fs.writeFileSync(path.join(dist, "picc-runtime.json"), "{bad");
    expectFailure(verifyCompiledRuntime({ packageRoot: fixtureRoot }), "corrupt");
    buildRuntime({ packageRoot: fixtureRoot });
    rewriteManifest((value) => { value.schemaVersion = 2; });
    expectFailure(verifyCompiledRuntime({ packageRoot: fixtureRoot }), "corrupt");
    buildRuntime({ packageRoot: fixtureRoot });
    rewriteManifest((value) => { delete (value.compiler as Partial<RuntimeManifest["compiler"]>).dependencyLockPath; });
    expectFailure(verifyCompiledRuntime({ packageRoot: fixtureRoot }), "corrupt");
    buildRuntime({ packageRoot: fixtureRoot });
    rewriteManifest((value) => { value.compiler.dependencyLockSha256 = "A".repeat(64); });
    expectFailure(verifyCompiledRuntime({ packageRoot: fixtureRoot }), "corrupt");
    buildRuntime({ packageRoot: fixtureRoot });
    rewriteManifest((value) => { value.runtimeDigest = "0".repeat(64); });
    expectFailure(verifyCompiledRuntime({ packageRoot: fixtureRoot }), "corrupt");
  });

  it("requires both compiled entry/map pairs in a self-consistent manifest", () => {
    const manifestPath = path.join(fixtureRoot, "dist", "picc-runtime.json");
    const originalManifest = fs.readFileSync(manifestPath);
    for (const requiredPair of [
      ["dist/index.js", "dist/index.js.map"],
      ["dist/plugin-inventory-cli.js", "dist/plugin-inventory-cli.js.map"],
      ["dist/mcp-administration-cli.js", "dist/mcp-administration-cli.js.map"],
    ]) {
      const originalFiles = requiredPair.map((requiredPath) => {
        const physicalPath = path.join(fixtureRoot, ...requiredPath.split("/"));
        return { physicalPath, contents: fs.readFileSync(physicalPath) };
      });
      try {
        rewriteManifest((value) => {
          value.files = value.files.filter((record) => !requiredPair.includes(record.path));
        }, true);
        for (const { physicalPath } of originalFiles) fs.rmSync(physicalPath);
        expectFailure(verifyCompiledRuntime({ packageRoot: fixtureRoot }), "corrupt");
      } finally {
        for (const { physicalPath, contents } of originalFiles) fs.writeFileSync(physicalPath, contents);
        fs.writeFileSync(manifestPath, originalManifest);
      }
    }
  });

  it("rejects a self-consistent manifest whose MCP entry does not name the exact authorized output", () => {
    rewriteManifest((value) => { value.entries.mcpAdministration = "dist/plugin-inventory-cli.js"; }, true);
    expectFailure(verifyCompiledRuntime({ packageRoot: fixtureRoot }), "corrupt");
  });

  it("rejects changed, missing, unexpected, mapless, orphan-map, and unsafe-map output", () => {
    const dist = path.join(fixtureRoot, "dist");
    fs.appendFileSync(path.join(dist, "index.js"), "// corrupt\n");
    expectFailure(verifyCompiledRuntime({ packageRoot: fixtureRoot }), "corrupt");
    buildRuntime({ packageRoot: fixtureRoot });
    fs.rmSync(path.join(dist, "index.js"));
    expectFailure(verifyCompiledRuntime({ packageRoot: fixtureRoot }), "corrupt");
    buildRuntime({ packageRoot: fixtureRoot });
    fs.writeFileSync(path.join(dist, "stale.js"), "export {};\n");
    expectFailure(verifyCompiledRuntime({ packageRoot: fixtureRoot }), "corrupt");
    buildRuntime({ packageRoot: fixtureRoot });
    fs.rmSync(path.join(dist, "index.js.map"));
    expectFailure(verifyCompiledRuntime({ packageRoot: fixtureRoot }), "corrupt");
    buildRuntime({ packageRoot: fixtureRoot });
    fs.rmSync(path.join(dist, "index.js"));
    expectFailure(verifyCompiledRuntime({ packageRoot: fixtureRoot }), "corrupt");
    buildRuntime({ packageRoot: fixtureRoot });
    const mapPath = path.join(dist, "index.js.map");
    const map = JSON.parse(fs.readFileSync(mapPath, "utf8")) as { sources: string[] };
    map.sources = ["C:/checkout/src/index.ts"];
    fs.writeFileSync(mapPath, JSON.stringify(map));
    rewriteManifest((value) => { value.files.find((file) => file.path === "dist/index.js.map")!.sha256 = hashFile(mapPath); }, true);
    expectFailure(verifyCompiledRuntime({ packageRoot: fixtureRoot }), "corrupt");
  });

  it("accepts ..helper and NFC records while rejecting traversal, empty segments, absolute and Windows forms, controls, decomposed Unicode, duplicates, and case collisions", () => {
    expect(manifest().sources.some((record) => record.path === "src/nested/café.ts")).toBe(true);
    rewriteManifest((value) => {
      value.sources.unshift({ path: "src/..helper.ts", sha256: "0".repeat(64) });
    }, true);
    expectVerified(false);
    buildRuntime({ packageRoot: fixtureRoot });
    const hostile = [
      "../escape.js", "dist/../escape.js", "dist//empty.js", "/absolute.js", "C:/hostile.js", "C:\\hostile.js",
      "dist\\hostile.js", "dist/hostile\u0001.js", "dist/cafe\u0301.js",
    ];
    for (const recordPath of hostile) {
      rewriteManifest((value) => { value.files[0] = { ...value.files[0]!, path: recordPath }; });
      expectFailure(verifyCompiledRuntime({ packageRoot: fixtureRoot }), "corrupt");
      buildRuntime({ packageRoot: fixtureRoot });
    }
    rewriteManifest((value) => { value.files.splice(1, 0, { ...value.files[0]! }); });
    expectFailure(verifyCompiledRuntime({ packageRoot: fixtureRoot }), "corrupt");
    buildRuntime({ packageRoot: fixtureRoot });
    rewriteManifest((value) => { value.files.splice(1, 0, { ...value.files[0]!, path: value.files[0]!.path.toUpperCase() }); });
    expectFailure(verifyCompiledRuntime({ packageRoot: fixtureRoot }), "corrupt");
  });

  it("rejects source-root and nested-source symlinks", () => {
    const source = path.join(fixtureRoot, "src");
    const saved = path.join(fixtureRoot, "source saved");
    fs.renameSync(source, saved);
    try {
      fs.symlinkSync(saved, source, "junction");
      expectFailure(verifyCompiledRuntime({ packageRoot: fixtureRoot, checkSource: true }), "source-stale");
    } finally {
      fs.rmSync(source, { recursive: true, force: true });
      fs.renameSync(saved, source);
    }
    const nested = path.join(source, "nested");
    const nestedSaved = path.join(source, "nested saved");
    fs.renameSync(nested, nestedSaved);
    try {
      fs.symlinkSync(nestedSaved, nested, "junction");
      expectFailure(verifyCompiledRuntime({ packageRoot: fixtureRoot, checkSource: true }), "source-stale");
    } finally {
      fs.rmSync(nested, { recursive: true, force: true });
      fs.renameSync(nestedSaved, nested);
    }
  });

  it("rejects symlinked package, lock, and config files without throwing", () => {
    symlinkFileCase("package.json", () => {
      expectFailure(verifyCompiledRuntime({ packageRoot: fixtureRoot, checkSource: true }), "source-stale");
      expectFailure(verifyCompiledRuntime({ packageRoot: fixtureRoot, checkSource: false }), "version-mismatch");
    });
    symlinkFileCase("package-lock.json", () => expectFailure(verifyCompiledRuntime({ packageRoot: fixtureRoot, checkSource: true }), "source-stale"));
    symlinkFileCase("tsconfig.runtime.json", () => expectFailure(verifyCompiledRuntime({ packageRoot: fixtureRoot, checkSource: true }), "source-stale"));
  });

  it("rejects symlinked manifest, runtime file, and intermediate runtime directory", () => {
    symlinkFileCase("dist/picc-runtime.json", () => expectFailure(verifyCompiledRuntime({ packageRoot: fixtureRoot }), "corrupt"));
    symlinkFileCase("dist/index.js", () => expectFailure(verifyCompiledRuntime({ packageRoot: fixtureRoot }), "corrupt"));
    const nested = path.join(fixtureRoot, "dist", "nested");
    const saved = path.join(fixtureRoot, "dist", "nested saved");
    fs.renameSync(nested, saved);
    try {
      fs.symlinkSync(saved, nested, "junction");
      expectFailure(verifyCompiledRuntime({ packageRoot: fixtureRoot }), "corrupt");
    } finally {
      fs.rmSync(nested, { recursive: true, force: true });
      fs.renameSync(saved, nested);
    }
  });

  it("turns filesystem access failures and read races into bounded product-state results", () => {
    const realLstat = fs.lstatSync;
    vi.spyOn(fs, "lstatSync").mockImplementation(((target: fs.PathLike, ...args: unknown[]) => {
      if (path.resolve(String(target)) === path.join(fixtureRoot, "dist")) {
        const error = Object.assign(new Error("secret access detail"), { code: "EACCES" });
        throw error;
      }
      return realLstat(target, ...(args as []));
    }) as typeof fs.lstatSync);
    const inaccessible = verifyCompiledRuntime({ packageRoot: fixtureRoot });
    expectFailure(inaccessible, "corrupt");
    expect(JSON.stringify(inaccessible)).not.toContain("secret access detail");
    vi.restoreAllMocks();

    const manifestPath = path.join(fixtureRoot, "dist", "picc-runtime.json");
    const realRead = fs.readFileSync;
    vi.spyOn(fs, "readFileSync").mockImplementation(((target: fs.PathOrFileDescriptor, ...args: unknown[]) => {
      if (path.resolve(String(target)) === manifestPath) throw Object.assign(new Error("raced away"), { code: "ENOENT" });
      return realRead(target, ...(args as []));
    }) as typeof fs.readFileSync);
    expectFailure(verifyCompiledRuntime({ packageRoot: fixtureRoot }), "corrupt");
  });

  it("binds package, compiler, bootstrap, runtime, and source evidence to exact successful reads", () => {
    const realRead = fs.readFileSync;
    const readRaceCases = [
      ["package.json", "source-stale"], ["package-lock.json", "source-stale"], ["tsconfig.runtime.json", "source-stale"],
      ["dist/picc-runtime.json", "corrupt"],
    ] as const;
    for (const [relative, category] of readRaceCases) {
      const target = path.join(fixtureRoot, ...relative.split("/"));
      let mutated = false;
      vi.spyOn(fs, "readFileSync").mockImplementation(((candidate: fs.PathOrFileDescriptor, ...args: unknown[]) => {
        const bytes = realRead(candidate, ...(args as []));
        if (!mutated && path.resolve(String(candidate)) === target) {
          mutated = true;
          fs.appendFileSync(target, " ");
        }
        return bytes;
      }) as typeof fs.readFileSync);
      expectFailure(verifyCompiledRuntime({ packageRoot: fixtureRoot, checkSource: true }), category);
      vi.restoreAllMocks();
      buildRuntime({ packageRoot: fixtureRoot });
    }

    const runtimeReadTarget = path.join(fixtureRoot, "dist", "index.js");
    let runtimeMutated = false;
    vi.spyOn(fs, "readFileSync").mockImplementation(((candidate: fs.PathOrFileDescriptor, ...args: unknown[]) => {
      const bytes = realRead(candidate, ...(args as []));
      if (!runtimeMutated && path.resolve(String(candidate)) === runtimeReadTarget) {
        runtimeMutated = true;
        fs.appendFileSync(runtimeReadTarget, "// changed immediately after exact read\n");
      }
      return bytes;
    }) as typeof fs.readFileSync);
    const runtimeReadRace = verifyCompiledRuntime({ packageRoot: fixtureRoot });
    expectFailure(runtimeReadRace, "corrupt");
    expect(JSON.stringify(runtimeReadRace).length).toBeLessThan(200);
    expect(JSON.stringify(runtimeReadRace)).not.toMatch(/changed immediately|exact read|index\.js/iu);
    vi.restoreAllMocks();
    buildRuntime({ packageRoot: fixtureRoot });

    const typescriptPackage = fs.realpathSync.native(path.join(fixtureRoot, "node_modules", "typescript", "package.json"));
    const realLstat = fs.lstatSync;
    let typescriptStats = 0;
    vi.spyOn(fs, "lstatSync").mockImplementation(((candidate: fs.PathLike, options?: fs.StatOptions) => {
      const stat = realLstat(candidate, options as never);
      if (path.resolve(String(candidate)) !== typescriptPackage || options?.bigint !== true || ++typescriptStats === 1) return stat;
      const changed = Object.create(stat) as fs.BigIntStats & { ctimeNs: bigint };
      Object.defineProperty(changed, "ctimeNs", { value: (stat as unknown as fs.BigIntStats).ctimeNs + 1n });
      return changed;
    }) as typeof fs.lstatSync);
    expectFailure(verifyCompiledRuntime({ packageRoot: fixtureRoot, checkSource: true }), "source-stale");
    vi.restoreAllMocks();

    const bootstrap = path.join(fixtureRoot, "picc", "index.ts");
    const runtimeFile = path.join(fixtureRoot, "dist", "index.js");
    const lateBootstrap = path.join(fixtureRoot, "picc", "late.ts");
    const latePackage = path.join(fixtureRoot, "late-package-entry");
    vi.spyOn(fs, "readFileSync").mockImplementation(((target: fs.PathOrFileDescriptor, ...args: unknown[]) => {
      const bytes = realRead(target, ...(args as []));
      if (path.resolve(String(target)) === runtimeFile && !fs.existsSync(lateBootstrap)) {
        fs.appendFileSync(bootstrap, "// replaced after its verified read\n");
        fs.writeFileSync(lateBootstrap, "export {};\n");
        fs.writeFileSync(latePackage, "inventory drift\n");
      }
      return bytes;
    }) as typeof fs.readFileSync);
    expectFailure(verifyCompiledRuntime({ packageRoot: fixtureRoot }), "corrupt");
    vi.restoreAllMocks();
    fs.rmSync(lateBootstrap);
    fs.rmSync(latePackage);
    buildRuntime({ packageRoot: fixtureRoot });

    const firstSource = path.join(fixtureRoot, "src", "index.ts");
    const laterSource = path.join(fixtureRoot, "src", "mcp-administration-cli.ts");
    vi.spyOn(fs, "readFileSync").mockImplementation(((target: fs.PathOrFileDescriptor, ...args: unknown[]) => {
      const bytes = realRead(target, ...(args as []));
      if (path.resolve(String(target)) === laterSource) fs.appendFileSync(firstSource, "// changed after source read\n");
      return bytes;
    }) as typeof fs.readFileSync);
    expectFailure(verifyCompiledRuntime({ packageRoot: fixtureRoot, checkSource: true }), "source-stale");
    vi.restoreAllMocks();
    buildRuntime({ packageRoot: fixtureRoot });

    vi.spyOn(fs, "readFileSync").mockImplementation(((target: fs.PathOrFileDescriptor, ...args: unknown[]) => {
      const bytes = realRead(target, ...(args as []));
      if (path.resolve(String(target)) === runtimeFile) fs.writeFileSync(path.join(fixtureRoot, "dist", "late.js"), "export {};\n");
      return bytes;
    }) as typeof fs.readFileSync);
    expectFailure(verifyCompiledRuntime({ packageRoot: fixtureRoot }), "corrupt");
  });

  it("rejects source inventory add, delete, and rename races", () => {
    const sourceRoot = path.join(fixtureRoot, "src");
    const source = path.join(sourceRoot, "plugin-inventory-cli.ts");
    const original = fs.readFileSync(source);
    const realReaddir = fs.readdirSync;
    const mutations = [
      () => fs.writeFileSync(path.join(sourceRoot, "added.ts"), "export {};\n"),
      () => fs.rmSync(source),
      () => fs.renameSync(source, path.join(sourceRoot, "renamed.ts")),
    ];
    for (const mutate of mutations) {
      let changed = false;
      vi.spyOn(fs, "readdirSync").mockImplementation(((target: fs.PathLike, options?: unknown) => {
        const entries = realReaddir(target, options as never);
        if (!changed && path.resolve(String(target)) === sourceRoot) {
          changed = true;
          mutate();
        }
        return entries;
      }) as typeof fs.readdirSync);
      expectFailure(verifyCompiledRuntime({ packageRoot: fixtureRoot, checkSource: true }), "source-stale");
      vi.restoreAllMocks();
      fs.rmSync(path.join(sourceRoot, "added.ts"), { force: true });
      fs.rmSync(path.join(sourceRoot, "renamed.ts"), { force: true });
      fs.writeFileSync(source, original);
      buildRuntime({ packageRoot: fixtureRoot });
    }
  });

  it("rejects unstable or unsupported high-resolution file and directory evidence", () => {
    const realLstat = fs.lstatSync;
    for (const target of [path.join(fixtureRoot, "dist", "index.js"), path.join(fixtureRoot, "src"), fs.realpathSync.native(path.join(fixtureRoot, "node_modules", "typescript", "package.json"))]) {
      vi.spyOn(fs, "lstatSync").mockImplementation(((candidate: fs.PathLike, options?: fs.StatOptions) => {
        const stat = realLstat(candidate, options as never);
        if (path.resolve(String(candidate)) !== target || options?.bigint !== true) return stat;
        const unsupported = Object.create(stat) as fs.BigIntStats & { mtimeNs: undefined };
        Object.defineProperty(unsupported, "mtimeNs", { value: undefined });
        return unsupported;
      }) as typeof fs.lstatSync);
      expectFailure(verifyCompiledRuntime({ packageRoot: fixtureRoot, checkSource: true }), target.includes(`${path.sep}dist${path.sep}`) ? "corrupt" : "source-stale");
      vi.restoreAllMocks();
    }
  });

  it("bounds unstable source fallback capture as build-and-relaunch recovery", () => {
    fs.renameSync(path.join(fixtureRoot, "dist"), path.join(fixtureRoot, "saved dist"));
    const realLstat = fs.lstatSync;
    let rootBigintCalls = 0;
    vi.spyOn(fs, "lstatSync").mockImplementation(((candidate: fs.PathLike, options?: fs.StatOptions) => {
      const stat = realLstat(candidate, options as never);
      if (path.resolve(String(candidate)) !== fixtureRoot || options?.bigint !== true || ++rootBigintCalls === 1) return stat;
      const unsupported = Object.create(stat) as fs.BigIntStats & { ctimeNs: undefined };
      Object.defineProperty(unsupported, "ctimeNs", { value: undefined });
      return unsupported;
    }) as typeof fs.lstatSync);
    const result = selectPiccRuntime({ packageRoot: fixtureRoot, installationKind: "source" });
    expectFailure(result, "corrupt");
    if (result.ok) throw new Error("expected source fallback capture to fail");
    expect(result.reason).toMatch(/build.*exit.*relaunch/isu);
    expect(result.reason).not.toMatch(/selection|authentic|loader|provenance|evidence|digest|internal/iu);
  });

  it("permits missing-dist source fallback only with the exact sole TypeScript bootstrap inventory", () => {
    const dist = path.join(fixtureRoot, "dist");
    const savedDist = path.join(fixtureRoot, "saved dist");
    fs.renameSync(dist, savedDist);
    const bootstrapDirectory = path.join(fixtureRoot, "picc");
    const bootstrap = path.join(bootstrapDirectory, "index.ts");
    const originalBootstrap = fs.readFileSync(bootstrap);
    const cases: Array<{ name: string; mutate: () => void; restore: () => void }> = [
      {
        name: "missing",
        mutate: () => fs.rmSync(bootstrap),
        restore: () => fs.writeFileSync(bootstrap, originalBootstrap),
      },
      {
        name: "legacy JavaScript",
        mutate: () => fs.writeFileSync(path.join(bootstrapDirectory, "index.js"), "export default function legacy() {}\n"),
        restore: () => fs.rmSync(path.join(bootstrapDirectory, "index.js"), { force: true }),
      },
      {
        name: "unexpected",
        mutate: () => fs.writeFileSync(path.join(bootstrapDirectory, "unexpected.ts"), "export {};\n"),
        restore: () => fs.rmSync(path.join(bootstrapDirectory, "unexpected.ts"), { force: true }),
      },
    ];
    const caseCollision = path.join(bootstrapDirectory, "Index.ts");
    if (!fs.existsSync(caseCollision)) {
      cases.push({
        name: "case-colliding",
        mutate: () => fs.writeFileSync(caseCollision, "export {};\n"),
        restore: () => fs.rmSync(caseCollision, { force: true }),
      });
    }

    try {
      expect(selectPiccRuntime({ packageRoot: fixtureRoot, installationKind: "source" })).toMatchObject({ ok: true, mode: "source" });
      for (const testCase of cases) {
        testCase.mutate();
        try {
          const sourceResult = selectPiccRuntime({ packageRoot: fixtureRoot, installationKind: "source" });
          expect(sourceResult.ok, testCase.name).toBe(false);
          expectFailure(sourceResult, "corrupt");
          const installedResult = selectPiccRuntime({ packageRoot: fixtureRoot, installationKind: "installed" });
          expect(installedResult.ok, testCase.name).toBe(false);
          expectFailure(installedResult, "missing");
        } finally {
          testCase.restore();
        }
      }
    } finally {
      if (!fs.existsSync(bootstrap)) fs.writeFileSync(bootstrap, originalBootstrap);
      fs.renameSync(savedDist, dist);
    }
  });

  it("returns installation-aware exact selector unions without forwarding verifier prose", () => {
    const expectedManifest = manifest();
    expect(selectPiccRuntime({ packageRoot: fixtureRoot, installationKind: "installed" })).toStrictEqual({
      ok: true, mode: "compiled", entries: { extensionPath: "picc/index.ts", pluginInventoryPath: "dist/plugin-inventory-cli.js", mcpAdministrationPath: "dist/mcp-administration-cli.js" },
      manifest: expectedManifest, notice: null,
    });
    const saved = path.join(fixtureRoot, "saved dist");
    fs.renameSync(path.join(fixtureRoot, "dist"), saved);
    expect(selectPiccRuntime({ packageRoot: fixtureRoot, installationKind: "source" })).toStrictEqual({
      ok: true, mode: "source", entries: { extensionPath: "picc/index.ts", pluginInventoryPath: "src/plugin-inventory-cli.ts", mcpAdministrationPath: "src/mcp-administration-cli.ts" },
      notice: {
        category: "missing",
        message: "PiCC is using TypeScript source because the compiled runtime is missing. Run `npm run build` from the PiCC checkout root, then exit and relaunch PiCC to restore compiled startup.",
      },
    });
    expect(selectPiccRuntime({ packageRoot: fixtureRoot, installationKind: "installed" })).toStrictEqual({
      ok: false,
      category: "missing",
      reason: "The installed PiCC runtime is missing. Update or reinstall PiCC, then relaunch.",
    });
    fs.renameSync(saved, path.join(fixtureRoot, "dist"));

    fs.appendFileSync(path.join(fixtureRoot, "src", "index.ts"), "// stale\n");
    expect(selectPiccRuntime({ packageRoot: fixtureRoot, installationKind: "source" })).toStrictEqual({
      ok: true, mode: "source", entries: { extensionPath: "picc/index.ts", pluginInventoryPath: "src/plugin-inventory-cli.ts", mcpAdministrationPath: "src/mcp-administration-cli.ts" },
      notice: {
        category: "source-stale",
        message: "PiCC is using TypeScript source because the compiled runtime does not match this checkout. Run `npm run build` from the PiCC checkout root; `/reload` cannot apply this runtime change, so exit PiCC and relaunch.",
      },
    });
    fs.appendFileSync(path.join(fixtureRoot, "dist", "index.js"), "// corrupt\n");
    expect(selectPiccRuntime({ packageRoot: fixtureRoot, installationKind: "source" })).toStrictEqual({
      ok: false,
      category: "corrupt",
      reason: "The source-checkout compiled runtime is damaged. Run `npm run build` from the PiCC checkout root, then exit and relaunch PiCC.",
    });
    expect(selectPiccRuntime({ packageRoot: fixtureRoot, installationKind: "installed" })).toStrictEqual({
      ok: false,
      category: "corrupt",
      reason: "The installed PiCC runtime is damaged. Update or reinstall PiCC, then relaunch.",
    });

    buildRuntime({ packageRoot: fixtureRoot });
    const packageJson = JSON.parse(fs.readFileSync(path.join(fixtureRoot, "package.json"), "utf8")) as { version: string };
    packageJson.version = "9.9.9";
    fs.writeFileSync(path.join(fixtureRoot, "package.json"), JSON.stringify(packageJson));
    expect(selectPiccRuntime({ packageRoot: fixtureRoot, installationKind: "installed" })).toStrictEqual({
      ok: false,
      category: "version-mismatch",
      reason: "The installed PiCC runtime is version-incoherent. Update or reinstall PiCC, then relaunch.",
    });
  });

  it("retains frozen snapshots of every supplied package namespace export", async () => {
    const runtimeUrl = pathToFileURL(path.join(repositoryRoot, "bin", "picc-runtime.mjs"));
    runtimeUrl.searchParams.set("namespace-snapshot", "focused");
    const runtime = await import(runtimeUrl.href);
    const witnesses = {
      agentCore: ["Agent", "calculateContextTokens"],
      ai: ["StringEnum", "Type"],
      aiCompat: ["StringEnum", "openAICodexResponsesApi"],
      codingAgent: ["SessionManager", "createAgentSession", "defineTool", "withFileMutationQueue"],
      tui: ["Box", "KeybindingsManager", "getKeybindings", "visibleWidth"],
      typebox: ["Type", "Object"],
      typeboxCompile: ["Compile", "Validator"],
    } as const;
    const graph = Object.fromEntries(Object.entries(witnesses).map(([packageName, names]) => [
      packageName,
      Object.fromEntries([
        ...names.map((name) => [name, Object.freeze({ packageName, name })]),
        ["unwitnessed", Object.freeze({ packageName, name: "unwitnessed" })],
      ]),
    ])) as Record<string, Record<string, unknown>>;
    const originalWitness = graph.agentCore!.Agent;
    const originalUnwitnessed = graph.agentCore!.unwitnessed;

    const retained = runtime.installRuntimeHostGraph(graph) as Record<string, Record<string, unknown>>;
    expect(Object.isFrozen(retained)).toBe(true);
    for (const packageName of Object.keys(witnesses)) {
      expect(retained[packageName]).not.toBe(graph[packageName]);
      expect(Object.isFrozen(retained[packageName])).toBe(true);
      expect(Reflect.ownKeys(retained[packageName]!)).toEqual(Reflect.ownKeys(graph[packageName]!));
      for (const key of Reflect.ownKeys(graph[packageName]!)) {
        expect(retained[packageName]![key as string]).toBe(graph[packageName]![key as string]);
      }
    }

    graph.agentCore!.Agent = Object.freeze({ changed: "witness" });
    graph.agentCore!.unwitnessed = Object.freeze({ changed: "unwitnessed" });
    expect(retained.agentCore!.Agent).toBe(originalWitness);
    expect(retained.agentCore!.unwitnessed).toBe(originalUnwitnessed);

    const matchingGraph = Object.fromEntries(Object.entries(retained).map(([name, namespace]) => [name, { ...namespace }]));
    expect(runtime.installRuntimeHostGraph(matchingGraph)).toBe(retained);
    expect(() => runtime.installRuntimeHostGraph({
      ...matchingGraph,
      agentCore: { ...matchingGraph.agentCore, Agent: Object.freeze({ mismatch: true }) },
    })).toThrow("refused to mix non-identical Pi runtime package graphs");
  });

  it("keeps compiler diagnostics and source excerpts out of bounded build failures", () => {
    const secret = `${fixtureRoot}/src/private.ts:1 SECRET_SOURCE_TEXT ${"x".repeat(5000)}`;
    expect(() => buildRuntime({
      packageRoot: fixtureRoot,
      spawnSync: () => ({ status: 1, stdout: secret, stderr: secret, error: new Error(secret) }),
      uniqueId: () => "diagnostics",
    })).toThrowError("PiCC runtime compilation failed. Fix the TypeScript errors and retry.");
    try {
      buildRuntime({ packageRoot: fixtureRoot, spawnSync: () => { throw new Error(secret); }, uniqueId: () => "diagnostics-two" });
    } catch (error) {
      const message = String(error);
      expect(message.length).toBeLessThan(200);
      expect(message).not.toContain("SECRET_SOURCE_TEXT");
      expect(message).not.toContain(fixtureRoot);
    }
  });

  it("restores the old runtime when the second publication rename fails", () => {
    const oldManifest = fs.readFileSync(path.join(fixtureRoot, "dist", "picc-runtime.json"), "utf8");
    let renameCalls = 0;
    const fileSystem = { ...fs, renameSync(from: fs.PathLike, to: fs.PathLike): void {
      renameCalls += 1;
      if (renameCalls === 2) throw new Error("second rename blocked");
      fs.renameSync(from, to);
    } } as typeof fs;
    expect(() => buildRuntime({ packageRoot: fixtureRoot, fileSystem, uniqueId: () => "second-rename" })).toThrow("previous runtime was restored");
    expect(renameCalls).toBe(3);
    expect(fs.readFileSync(path.join(fixtureRoot, "dist", "picc-runtime.json"), "utf8")).toBe(oldManifest);
    expectVerified();
  });

  it("leaves an actionable missing state when publication and restoration both fail", () => {
    let renameCalls = 0;
    const fileSystem = { ...fs, renameSync(from: fs.PathLike, to: fs.PathLike): void {
      renameCalls += 1;
      if (renameCalls >= 2) throw new Error("rename blocked");
      fs.renameSync(from, to);
    } } as typeof fs;
    expect(() => buildRuntime({ packageRoot: fixtureRoot, fileSystem, uniqueId: () => "restore-failure" })).toThrow("could not be restored");
    expect(renameCalls).toBe(3);
    expectFailure(verifyCompiledRuntime({ packageRoot: fixtureRoot }), "missing");
    const backups = fs.readdirSync(fixtureRoot).filter((entry) => entry.startsWith("dist.backup-"));
    expect(backups).toHaveLength(1);
    fs.renameSync(path.join(fixtureRoot, backups[0]!), path.join(fixtureRoot, "dist"));
  });

  it("keeps a successfully published runtime when backup cleanup is blocked", () => {
    let blockedBackup = "";
    const fileSystem = { ...fs, rmSync(target: fs.PathLike, options?: fs.RmDirOptions): void {
      if (path.basename(String(target)).startsWith("dist.backup-")) {
        blockedBackup = String(target);
        throw new Error("cleanup blocked");
      }
      fs.rmSync(target, options);
    } } as typeof fs;
    expect(() => buildRuntime({ packageRoot: fixtureRoot, fileSystem, uniqueId: () => "cleanup-blocked" })).not.toThrow();
    expectVerified();
    expect(fs.existsSync(blockedBackup)).toBe(true);
  });

  it("rejects source drift during compilation and preserves the old publication", () => {
    const oldManifest = fs.readFileSync(path.join(fixtureRoot, "dist", "picc-runtime.json"), "utf8");
    const source = path.join(fixtureRoot, "src", "index.ts");
    expect(() => buildRuntime({
      packageRoot: fixtureRoot,
      uniqueId: () => "source-drift",
      spawnSync: (...args: Parameters<typeof realSpawnSync>) => {
        const result = realSpawnSync(...args);
        fs.appendFileSync(source, "// changed during compile\n");
        return result;
      },
    })).toThrow("source inputs changed during runtime compilation");
    expect(fs.readFileSync(path.join(fixtureRoot, "dist", "picc-runtime.json"), "utf8")).toBe(oldManifest);
    expectFailure(verifyCompiledRuntime({ packageRoot: fixtureRoot, checkSource: true }), "source-stale");
    expectVerified(false);
  });

  it("cleans stale old outputs through a verified new-tree publication", () => {
    fs.writeFileSync(path.join(fixtureRoot, "dist", "stale.js"), "export {};\n");
    expectFailure(verifyCompiledRuntime({ packageRoot: fixtureRoot }), "corrupt");
    buildRuntime({ packageRoot: fixtureRoot });
    expect(fs.existsSync(path.join(fixtureRoot, "dist", "stale.js"))).toBe(false);
    expectVerified();
  });

  it("uses relative source maps in a real Node stack without build-machine prefixes", () => {
    const map = JSON.parse(fs.readFileSync(path.join(fixtureRoot, "dist", "index.js.map"), "utf8")) as { sources: string[]; sourceRoot?: string };
    expect(map.sources).toStrictEqual(["../src/index.ts"]);
    expect(map.sourceRoot ?? "").toBe("");
    expect(map.sources.every((source) => !path.isAbsolute(source) && !source.includes(fixtureRoot) && !source.includes("\\"))).toBe(true);
    let stack = "";
    try {
      execFileSync(process.execPath, ["--enable-source-maps", "--input-type=module", "-e", `import(${JSON.stringify(pathToFileURL(path.join(fixtureRoot, "dist", "index.js")).href)}).then(m => m.default())`], {
        encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      stack = String((error as { stderr?: string }).stderr ?? error);
    }
    const portableStack = stack.replaceAll("\\", "/");
    expect(portableStack).toContain("src/index.ts");
    expect(portableStack).not.toContain("dist/index.js:");
  });

  it("binds the sole TypeScript bootstrap and rejects changed, linked, and legacy entry state", () => {
    const bootstrap = path.join(fixtureRoot, "picc", "index.ts");
    const builtManifest = manifest();
    expect(builtManifest.entries.extension).toBe("picc/index.ts");
    expect(builtManifest.files.find((record) => record.path === "picc/index.ts")?.sha256).toBe(hashFile(bootstrap));

    fs.appendFileSync(bootstrap, "// changed\n");
    expectFailure(verifyCompiledRuntime({ packageRoot: fixtureRoot }), "corrupt");
    buildRuntime({ packageRoot: fixtureRoot });

    symlinkFileCase("picc/index.ts", () => expectFailure(verifyCompiledRuntime({ packageRoot: fixtureRoot }), "corrupt"));

    fs.writeFileSync(path.join(fixtureRoot, "picc", "index.js"), "export default function legacy() {}\n");
    expectFailure(verifyCompiledRuntime({ packageRoot: fixtureRoot }), "corrupt");
  });

  it.each(["missing", "source-stale"] as const)("hands off %s source mode once while refusing authentic replacement and replay", (category) => {
    if (category === "missing") fs.renameSync(path.join(fixtureRoot, "dist"), path.join(fixtureRoot, "saved dist"));
    else fs.appendFileSync(path.join(fixtureRoot, "src", "index.ts"), "// stale source handoff\n");
    const result = runIsolatedRuntime(`
      const selected = runtime.selectPiccRuntime({ packageRoot: roots.fixtureRoot, installationKind: "source" });
      const replacement = runtime.selectPiccRuntime({ packageRoot: roots.fixtureRoot, installationKind: "source" });
      let forgedMessage = "";
      try { runtime.installInitialRuntimeSelection(structuredClone(selected)); } catch (error) { forgedMessage = String(error); }
      runtime.installInitialRuntimeSelection(selected);
      let replacementMessage = "";
      try { runtime.installInitialRuntimeSelection(replacement); } catch (error) { replacementMessage = String(error); }
      const realRead = fs.readFileSync;
      const realLstat = fs.lstatSync;
      let reads = 0;
      let verifierCalls = 0;
      fs.readFileSync = (...args) => { reads += 1; return realRead(...args); };
      fs.lstatSync = (...args) => { verifierCalls += 1; return realLstat(...args); };
      const adopted = runtime.selectPiccRuntime({ packageRoot: roots.fixtureRoot, installationKind: "source" });
      const adoption = { reads, verifierCalls };
      const retained = runtime.pinPiccRuntime({ packageRoot: roots.fixtureRoot, installationKind: "source", selection: adopted });
      let notices = 0;
      console.error = () => { notices += 1; };
      const firstNotice = runtime.presentPiccSourceNotice({ packageRoot: roots.fixtureRoot, installationKind: "source", representation: retained, selection: adopted });
      const repeatedNotice = runtime.presentPiccSourceNotice({ packageRoot: roots.fixtureRoot, installationKind: "source", representation: retained, selection: adopted });
      const direct = runtime.selectPiccRuntime({ packageRoot: roots.fixtureRoot, installationKind: "source" });
      const directCounts = { reads: reads - adoption.reads, verifierCalls: verifierCalls - adoption.verifierCalls, mode: direct.mode };
      const reloadRetained = runtime.pinPiccRuntime({ packageRoot: roots.fixtureRoot, installationKind: "source", selection: direct });
      const reloadNotice = runtime.presentPiccSourceNotice({ packageRoot: roots.fixtureRoot, installationKind: "source", representation: reloadRetained, selection: direct });
      let replayMessage = "";
      try { runtime.installInitialRuntimeSelection(selected); } catch (error) { replayMessage = String(error); }
      console.log(JSON.stringify({ category: adopted.notice.category, same: adopted === selected, forgedMessage, replacementMessage, replayMessage, adoption, direct: directCounts, reloadRetainedSame: reloadRetained === retained, notices, firstNotice, repeatedNotice, reloadNotice }));
    `) as {
      category: string; same: boolean; forgedMessage: string; replacementMessage: string; replayMessage: string;
      adoption: { reads: number; verifierCalls: number }; direct: { reads: number; verifierCalls: number; mode: string };
      reloadRetainedSame: boolean; notices: number; firstNotice: boolean; repeatedNotice: boolean; reloadNotice: boolean;
    };
    expect(result).toMatchObject({ category, same: true, adoption: { reads: 0 }, direct: { mode: "source" }, reloadRetainedSame: true, notices: 1, firstNotice: true, repeatedNotice: false, reloadNotice: false });
    expect(result.adoption.verifierCalls).toBeGreaterThan(0);
    if (category === "source-stale") {
      expect(result.direct.reads).toBeGreaterThan(0);
      expect(result.direct.verifierCalls).toBeGreaterThan(result.adoption.verifierCalls);
    } else {
      expect(result.direct.reads).toBe(0);
      expect(result.direct.verifierCalls).toBeGreaterThan(0);
    }
    for (const message of [result.replacementMessage, result.replayMessage]) {
      expect(message).toMatch(/build.*exit.*relaunch/isu);
      expect(message).not.toMatch(/selection|authentic|loader|provenance|evidence|digest|internal/iu);
    }
    expect(result.forgedMessage).toMatch(/startup.*repair.*relaunch/isu);
    expect(result.forgedMessage).not.toMatch(/build|selection|authentic|loader|provenance|evidence|digest|internal/iu);
    buildRuntime({ packageRoot: fixtureRoot });
  });

  it("consumes mismatched or changed handoffs and falls back to full verification afterward", () => {
    const otherRoot = fs.mkdtempSync(path.join(os.tmpdir(), "picc other runtime "));
    try {
      const crossRoot = runIsolatedRuntime(`
        const selected = runtime.selectPiccRuntime({ packageRoot: roots.fixtureRoot, installationKind: "installed" });
        runtime.installInitialRuntimeSelection(selected);
        const mismatch = runtime.selectPiccRuntime({ packageRoot: roots.otherRoot, installationKind: "installed" });
        const realRead = fs.readFileSync;
        let reads = 0;
        fs.readFileSync = (...args) => { reads += 1; return realRead(...args); };
        const direct = runtime.selectPiccRuntime({ packageRoot: roots.fixtureRoot, installationKind: "installed" });
        console.log(JSON.stringify({ mismatch, directOk: direct.ok, reads }));
      `, { fixtureRoot, otherRoot }) as { mismatch: { ok: boolean; category: string; reason: string }; directOk: boolean; reads: number };
      expectNeutralStartupContextMismatch(crossRoot.mismatch);
      expect(crossRoot).toMatchObject({ directOk: true });
      expect(crossRoot.reads).toBeGreaterThan(0);

      const changed = runIsolatedRuntime(`
        const selected = runtime.selectPiccRuntime({ packageRoot: roots.fixtureRoot, installationKind: "installed" });
        runtime.installInitialRuntimeSelection(selected);
        fs.appendFileSync(roots.fixtureRoot + "/dist/index.js", "// changed after handoff\\n");
        const adopted = runtime.selectPiccRuntime({ packageRoot: roots.fixtureRoot, installationKind: "installed" });
        console.log(JSON.stringify(adopted));
      `) as { ok: boolean; reason: string };
      expect(changed.ok).toBe(false);
      expect(changed.reason).toContain("Update or reinstall PiCC, then relaunch");
    } finally {
      fs.rmSync(otherRoot, { recursive: true, force: true });
      buildRuntime({ packageRoot: fixtureRoot });
    }
  });

  it("consumes install-kind, package, source, and inventory drift with bounded recovery before a complete next selection", () => {
    const installKind = runIsolatedRuntime(`
      const selected = runtime.selectPiccRuntime({ packageRoot: roots.fixtureRoot, installationKind: "installed" });
      runtime.installInitialRuntimeSelection(selected);
      const mismatch = runtime.selectPiccRuntime({ packageRoot: roots.fixtureRoot, installationKind: "source" });
      let reads = 0;
      const realRead = fs.readFileSync;
      fs.readFileSync = (...args) => { reads += 1; return realRead(...args); };
      const direct = runtime.selectPiccRuntime({ packageRoot: roots.fixtureRoot, installationKind: "installed" });
      console.log(JSON.stringify({ mismatch, directOk: direct.ok, reads }));
    `) as { mismatch: { ok: boolean; category: string; reason: string }; directOk: boolean; reads: number };
    expectNeutralStartupContextMismatch(installKind.mismatch);
    expect(installKind).toMatchObject({ directOk: true });
    expect(installKind.reads).toBeGreaterThan(0);

    for (const mutation of ["package", "inventory", "symlink"] as const) {
      const result = runIsolatedRuntime(`
        const selected = runtime.selectPiccRuntime({ packageRoot: roots.fixtureRoot, installationKind: "installed" });
        runtime.installInitialRuntimeSelection(selected);
        if (${JSON.stringify(mutation)} === "package") {
          const packagePath = roots.fixtureRoot + "/package.json";
          const value = JSON.parse(fs.readFileSync(packagePath, "utf8"));
          value.version = "9.9.9";
          fs.writeFileSync(packagePath, JSON.stringify(value));
        } else if (${JSON.stringify(mutation)} === "inventory") {
          fs.writeFileSync(roots.fixtureRoot + "/dist/unexpected.js", "export {};\\n");
        } else {
          const target = roots.fixtureRoot + "/dist/index.js";
          const realLstat = fs.lstatSync;
          fs.lstatSync = (...args) => {
            const stat = realLstat(...args);
            if (String(args[0]).replaceAll("\\\\", "/").toLowerCase() !== target.replaceAll("\\\\", "/").toLowerCase()) return stat;
            const linked = Object.create(stat);
            linked.isSymbolicLink = () => true;
            return linked;
          };
        }
        const mismatch = runtime.selectPiccRuntime({ packageRoot: roots.fixtureRoot, installationKind: "installed" });
        let reads = 0;
        const realRead = fs.readFileSync;
        fs.readFileSync = (...args) => { reads += 1; return realRead(...args); };
        const direct = runtime.selectPiccRuntime({ packageRoot: roots.fixtureRoot, installationKind: "installed" });
        console.log(JSON.stringify({ mismatch, direct, reads }));
      `) as { mismatch: { ok: boolean; reason: string }; direct: { ok: boolean; category?: string }; reads: number };
      expect(result.mismatch.ok, mutation).toBe(false);
      expect(result.mismatch.reason).toMatch(/relaunch/u);
      expect(result.mismatch.reason).not.toMatch(/selection|authentic|loader|provenance|evidence|digest|internal/iu);
      expect(result.direct.ok).toBe(false);
      expect(result.reads).toBeGreaterThan(0);
      buildRuntime({ packageRoot: fixtureRoot });
    }

    fs.appendFileSync(path.join(fixtureRoot, "src", "index.ts"), "// source fallback\n");
    const sourceMutation = runIsolatedRuntime(`
      const selected = runtime.selectPiccRuntime({ packageRoot: roots.fixtureRoot, installationKind: "source" });
      runtime.installInitialRuntimeSelection(selected);
      fs.appendFileSync(roots.fixtureRoot + "/src/index.ts", "// changed after install\\n");
      const mismatch = runtime.selectPiccRuntime({ packageRoot: roots.fixtureRoot, installationKind: "source" });
      let reads = 0;
      const realRead = fs.readFileSync;
      fs.readFileSync = (...args) => { reads += 1; return realRead(...args); };
      const direct = runtime.selectPiccRuntime({ packageRoot: roots.fixtureRoot, installationKind: "source" });
      console.log(JSON.stringify({ mismatch, directMode: direct.mode, reads }));
    `) as { mismatch: { ok: boolean; reason: string }; directMode: string; reads: number };
    expect(sourceMutation).toMatchObject({ mismatch: { ok: false }, directMode: "source" });
    expect(sourceMutation.mismatch.reason).toMatch(/build.*relaunch/isu);
    expect(sourceMutation.reads).toBeGreaterThan(0);
  });

  it("refuses retained representation and generation replacement while allowing a rebuilt generation in a fresh process", () => {
    const buildPath = path.join(repositoryRoot, "scripts", "build-runtime.mjs");
    const representation = runIsolatedRuntime(`
      const compiled = runtime.selectPiccRuntime({ packageRoot: roots.fixtureRoot, installationKind: "source" });
      runtime.pinPiccRuntime({ packageRoot: roots.fixtureRoot, installationKind: "source", selection: compiled });
      fs.appendFileSync(roots.fixtureRoot + "/src/index.ts", "// force source mode\\n");
      const source = runtime.selectPiccRuntime({ packageRoot: roots.fixtureRoot, installationKind: "source" });
      runtime.installInitialRuntimeSelection(source);
      const mismatch = runtime.selectPiccRuntime({ packageRoot: roots.fixtureRoot, installationKind: "source" });
      console.log(JSON.stringify(mismatch));
    `) as { ok: boolean; reason: string };
    expect(representation.ok).toBe(false);
    expect(representation.reason).toMatch(/\/reload.*cannot apply this runtime change.*exit.*relaunch/isu);
    expect(representation.reason).not.toMatch(/representation|generation/iu);
    buildRuntime({ packageRoot: fixtureRoot });

    const generation = runIsolatedRuntime(`
      const oldSelection = runtime.selectPiccRuntime({ packageRoot: roots.fixtureRoot, installationKind: "source" });
      fs.appendFileSync(roots.fixtureRoot + "/src/index.ts", "// next generation\\n");
      const builder = await import(pathToFileURL(roots.buildPath).href);
      builder.buildRuntime({ packageRoot: roots.fixtureRoot });
      const rebuilt = runtime.selectPiccRuntime({ packageRoot: roots.fixtureRoot, installationKind: "source" });
      runtime.pinPiccRuntime({ packageRoot: roots.fixtureRoot, installationKind: "source", selection: rebuilt });
      runtime.installInitialRuntimeSelection(oldSelection);
      const mismatch = runtime.selectPiccRuntime({ packageRoot: roots.fixtureRoot, installationKind: "source" });
      console.log(JSON.stringify({ mismatch, rebuiltOk: rebuilt.ok, changed: oldSelection.manifest.runtimeDigest !== rebuilt.manifest.runtimeDigest }));
    `, { fixtureRoot, buildPath }) as { mismatch: { ok: boolean; reason: string }; rebuiltOk: boolean; changed: boolean };
    expect(generation).toMatchObject({ mismatch: { ok: false }, rebuiltOk: true, changed: true });
    expect(generation.mismatch.reason).toMatch(/\/reload.*cannot apply this runtime change.*exit.*relaunch/isu);
    expect(generation.mismatch.reason).not.toMatch(/representation|generation/iu);

    const fresh = runIsolatedRuntime(`
      const selected = runtime.selectPiccRuntime({ packageRoot: roots.fixtureRoot, installationKind: "source" });
      console.log(JSON.stringify({ ok: selected.ok, mode: selected.mode }));
    `) as { ok: boolean; mode: string };
    expect(fresh).toStrictEqual({ ok: true, mode: "compiled" });
  });

  it("keeps source reload source-hosted after a build and does not carry handoff state into a fresh process", () => {
    fs.appendFileSync(path.join(fixtureRoot, "src", "index.ts"), "// source reload\n");
    const buildPath = path.join(repositoryRoot, "scripts", "build-runtime.mjs");
    const result = runIsolatedRuntime(`
      const selected = runtime.selectPiccRuntime({ packageRoot: roots.fixtureRoot, installationKind: "source" });
      runtime.installInitialRuntimeSelection(selected);
      const adopted = runtime.selectPiccRuntime({ packageRoot: roots.fixtureRoot, installationKind: "source" });
      const retained = runtime.pinPiccRuntime({ packageRoot: roots.fixtureRoot, installationKind: "source", selection: adopted });
      const builder = await import(pathToFileURL(roots.buildPath).href);
      builder.buildRuntime({ packageRoot: roots.fixtureRoot });
      const reloaded = runtime.selectPiccRuntime({ packageRoot: roots.fixtureRoot, installationKind: "source" });
      const repinned = runtime.pinPiccRuntime({ packageRoot: roots.fixtureRoot, installationKind: "source", selection: reloaded });
      console.log(JSON.stringify({ retainedMode: retained.mode, reloadMode: reloaded.mode, repinnedMode: repinned.mode, sameRepresentation: repinned === retained }));
    `, { fixtureRoot, buildPath }) as { retainedMode: string; reloadMode: string; repinnedMode: string; sameRepresentation: boolean };
    expect(result).toStrictEqual({ retainedMode: "source", reloadMode: "compiled", repinnedMode: "source", sameRepresentation: true });
    expect(runIsolatedRuntime(`
      const selected = runtime.selectPiccRuntime({ packageRoot: roots.fixtureRoot, installationKind: "source" });
      console.log(JSON.stringify({ ok: selected.ok, mode: selected.mode }));
    `)).toStrictEqual({ ok: true, mode: "compiled" });
  });

  it.skipIf(process.platform !== "win32")("folds Windows case aliases only for retained representation and source notice ownership", () => {
    fs.appendFileSync(path.join(fixtureRoot, "src", "index.ts"), "// source alias\n");
    const result = runIsolatedRuntime(`
      const alias = roots.fixtureRoot.replace(/^[A-Za-z]:/, drive => (drive[0] === drive[0].toUpperCase() ? drive[0].toLowerCase() : drive[0].toUpperCase()) + ":");
      const selected = runtime.selectPiccRuntime({ packageRoot: roots.fixtureRoot, installationKind: "source" });
      runtime.installInitialRuntimeSelection(selected);
      const adopted = runtime.selectPiccRuntime({ packageRoot: alias, installationKind: "source" });
      const retained = runtime.pinPiccRuntime({ packageRoot: alias, installationKind: "source", selection: adopted });
      let notices = 0;
      console.error = () => { notices += 1; };
      runtime.presentPiccSourceNotice({ packageRoot: roots.fixtureRoot, installationKind: "source", representation: retained, selection: adopted });
      runtime.presentPiccSourceNotice({ packageRoot: alias, installationKind: "source", representation: retained, selection: adopted });
      console.log(JSON.stringify({ same: adopted === selected, nativeRoot: retained.root === fs.realpathSync.native(roots.fixtureRoot), notices }));
    `) as { same: boolean; nativeRoot: boolean; notices: number };
    expect(result).toStrictEqual({ same: true, nativeRoot: true, notices: 1 });
  });

  it.skipIf(process.platform === "win32")("keeps POSIX case-distinct physical roots separate", () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "picc case roots "));
    const lower = path.join(parent, "runtime");
    const upper = path.join(parent, "Runtime");
    try {
      fs.cpSync(fixtureRoot, lower, { recursive: true, dereference: false });
      fs.cpSync(fixtureRoot, upper, { recursive: true, dereference: false });
      const result = runIsolatedRuntime(`
        const selected = runtime.selectPiccRuntime({ packageRoot: roots.lower, installationKind: "installed" });
        runtime.installInitialRuntimeSelection(selected);
        const mismatch = runtime.selectPiccRuntime({ packageRoot: roots.upper, installationKind: "installed" });
        let reads = 0;
        const realRead = fs.readFileSync;
        fs.readFileSync = (...args) => { reads += 1; return realRead(...args); };
        const direct = runtime.selectPiccRuntime({ packageRoot: roots.lower, installationKind: "installed" });
        console.log(JSON.stringify({ mismatchOk: mismatch.ok, directOk: direct.ok, reads }));
      `, { lower, upper }) as { mismatchOk: boolean; directOk: boolean; reads: number };
      expect(result).toMatchObject({ mismatchOk: false, directOk: true });
      expect(result.reads).toBeGreaterThan(0);
    } finally {
      fs.rmSync(parent, { recursive: true, force: true });
    }
  });

  it("rejects forged and failed handoffs, ignores ambient slots, delegates query identities, and consumes before implementation failure", () => {
    const result = runIsolatedRuntime(`
      const saved = roots.fixtureRoot + "/saved dist";
      fs.renameSync(roots.fixtureRoot + "/dist", saved);
      const failed = runtime.selectPiccRuntime({ packageRoot: roots.fixtureRoot, installationKind: "installed" });
      let failedMessage = "";
      try { runtime.installInitialRuntimeSelection(failed); } catch (error) { failedMessage = String(error); }
      fs.renameSync(saved, roots.fixtureRoot + "/dist");

      const selected = runtime.selectPiccRuntime({ packageRoot: roots.fixtureRoot, installationKind: "installed" });
      let forgedMessage = "";
      try { runtime.installInitialRuntimeSelection(structuredClone(selected)); } catch (error) { forgedMessage = String(error); }
      const ambientSlot = Symbol.for("@arnedeutsch/picc.initial-runtime-selection.v1");
      Object.defineProperty(process, ambientSlot, { value: { consume: () => structuredClone(selected) }, configurable: true });
      Object.defineProperty(globalThis, ambientSlot, { value: structuredClone(selected), configurable: true });
      runtime.installInitialRuntimeSelection(selected);
      const consumer = await import(runtimeUrl + "?initial-consumer=query-import");
      const alias = process.platform === "win32"
        ? roots.fixtureRoot.replace(/^[A-Za-z]:/, drive => (drive[0] === drive[0].toUpperCase() ? drive[0].toLowerCase() : drive[0].toUpperCase()) + ":")
        : roots.fixtureRoot;
      const realRead = fs.readFileSync;
      const realLstat = fs.lstatSync;
      let reads = 0;
      let verifierCalls = 0;
      fs.readFileSync = (...args) => { reads += 1; return realRead(...args); };
      fs.lstatSync = (...args) => { verifierCalls += 1; return realLstat(...args); };
      const adopted = consumer.selectPiccRuntime({ packageRoot: alias, installationKind: "installed" });
      const adoption = { reads, verifierCalls, same: adopted === selected };
      const retained = consumer.pinPiccRuntime({ packageRoot: alias, installationKind: "installed", selection: adopted });
      const implementationPath = retained.mode === "compiled" ? "dist/extension.js" : "src/extension.ts";

      let implementationFailed = false;
      try {
        await import(pathToFileURL(roots.fixtureRoot + "/" + implementationPath).href);
      } catch { implementationFailed = true; }
      reads = 0;
      verifierCalls = 0;
      const direct = runtime.selectPiccRuntime({ packageRoot: roots.fixtureRoot, installationKind: "installed" });
      const directCounts = { reads, verifierCalls };
      let replayMessage = "";
      try { runtime.installInitialRuntimeSelection(selected); } catch (error) { replayMessage = String(error); }
      fs.appendFileSync(roots.fixtureRoot + "/dist/index.js", "// corrupt reload\\n");
      const corrupt = runtime.selectPiccRuntime({ packageRoot: roots.fixtureRoot, installationKind: "installed" });
      console.log(JSON.stringify({ failedMessage, forgedMessage, adoption, retainedMode: retained.mode, implementationFailed, directOk: direct.ok, directCounts, replayMessage, corrupt }));
    `) as {
      failedMessage: string; forgedMessage: string; adoption: { reads: number; verifierCalls: number; same: boolean };
      retainedMode: string; implementationFailed: boolean; directOk: boolean; directCounts: { reads: number; verifierCalls: number }; replayMessage: string; corrupt: { ok: boolean; category: string };
    };
    for (const message of [result.failedMessage, result.forgedMessage, result.replayMessage]) {
      expect(message).toMatch(/startup.*repair.*relaunch/isu);
      expect(message).not.toMatch(/selection|authentic|loader|provenance|evidence|digest|internal/iu);
    }
    expect(result.adoption).toMatchObject({ reads: 0, same: true });
    expect(result.adoption.verifierCalls).toBeGreaterThan(0);
    expect(result.retainedMode).toBe("compiled");
    expect(result.implementationFailed).toBe(true);
    expect(result.directOk).toBe(true);
    expect(result.directCounts.reads).toBeGreaterThan(0);
    expect(result.directCounts.verifierCalls).toBeGreaterThan(result.adoption.verifierCalls);
    expect(result.corrupt).toMatchObject({ ok: false, category: "corrupt" });
  });
});

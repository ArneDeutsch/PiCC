import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { PI_SUITE_PACKAGES, discoverNpmCommand, validatePiSuite } from "../bin/picc-admin.mjs";
import {
  BASH_AVAILABLE,
  createE2ELive,
  REPO_ROOT,
  TEST_TIMEOUT_MS,
  systemText,
  toolNames,
  toolResultText,
} from "./helpers/e2e-live.js";
import { cleanupFixture, materializeFixture } from "./helpers/fixture.js";
import {
  createPluginLifecycleFixture,
  LIFECYCLE_BASE_ID,
  LIFECYCLE_MARKETPLACE,
  lifecycleSubprocessEnv,
} from "./helpers/plugin-lifecycle-fixture.js";

interface SourceManifest {
  name: string;
  version: string;
  bin: { picc: string };
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
}

function readSourceManifest(): SourceManifest {
  const parsed: unknown = JSON.parse(fs.readFileSync(path.resolve("package.json"), "utf8"));
  if (
    !isObject(parsed)
    || typeof parsed.name !== "string"
    || typeof parsed.version !== "string"
    || !isObject(parsed.bin)
    || typeof parsed.bin.picc !== "string"
  ) {
    throw new Error("package.json has an invalid packaged-release manifest");
  }
  return {
    name: parsed.name,
    version: parsed.version,
    bin: { picc: parsed.bin.picc },
    dependencies: stringMap(parsed.dependencies, "package.json dependencies"),
    devDependencies: stringMap(parsed.devDependencies, "package.json devDependencies"),
  };
}

const { runPi, cleanup } = createE2ELive({ runtime: "installed-launcher" });
const sourceManifest = readSourceManifest();
const expectedPiPins = PI_SUITE_PACKAGES.map((name) => sourceManifest.dependencies[name]);
const expectedPiVersion = expectedPiPins[0]!;
const tempDirs: string[] = [];
let tarball: string;
let packageRoot: string;
let launcher: string;

function temporaryDirectory(prefix: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(directory);
  return directory;
}

function treeSnapshot(root: string): string[] {
  const values: string[] = [];
  const visit = (directory: string) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const filename = path.join(directory, entry.name);
      const relative = path.relative(root, filename).split(path.sep).join("/");
      const metadata = fs.lstatSync(filename);
      const mode = (metadata.mode & 0o7777).toString(8);
      if (metadata.isSymbolicLink()) {
        values.push(`${relative}:link:${mode}:${fs.readlinkSync(filename)}`);
      } else if (metadata.isDirectory()) {
        values.push(`${relative}/:directory:${mode}`);
        visit(filename);
      } else if (metadata.isFile()) {
        values.push(`${relative}:file:${mode}:${fs.readFileSync(filename).toString("base64")}`);
      } else {
        values.push(`${relative}:other:${mode}`);
      }
    }
  };
  visit(root);
  return values;
}

function releaseTarball(): string {
  const supplied = process.env.PICC_TEST_TARBALL;
  if (supplied) {
    const resolved = fs.realpathSync(path.resolve(supplied));
    if (!fs.statSync(resolved).isFile() || !resolved.endsWith(".tgz")) {
      throw new Error("PICC_TEST_TARBALL must name a canonical release tarball");
    }
    return resolved;
  }

  const outputDirectory = temporaryDirectory("picc-packaged-pack-");
  const output = execFileSync(
    process.execPath,
    [path.resolve("scripts/pack-release.mjs"), "--output-dir", outputDirectory, "--event", "manual"],
    { cwd: path.resolve("."), encoding: "utf8", timeout: 120_000 },
  );
  const parsed: unknown = JSON.parse(output);
  if (!isObject(parsed) || typeof parsed.tarball !== "string") {
    throw new Error("pack helper returned no tarball");
  }
  return fs.realpathSync(parsed.tarball);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringMap(value: unknown, owner: string): Record<string, string> {
  if (!isObject(value)) throw new Error(`${owner} must be an object`);
  const result: Record<string, string> = {};
  for (const [name, version] of Object.entries(value)) {
    if (typeof version !== "string") throw new Error(`${owner}.${name} must be a string`);
    result[name] = version;
  }
  return result;
}

function assertSameStringMap(
  actual: Record<string, string>,
  expected: Record<string, string>,
  owner: string,
): void {
  const actualNames = Object.keys(actual).sort();
  const expectedNames = Object.keys(expected).sort();
  if (
    actualNames.length !== expectedNames.length
    || actualNames.some((name, index) => name !== expectedNames[index] || actual[name] !== expected[name])
  ) {
    throw new Error(`${owner} does not exactly match package.json dependencies`);
  }
}

function writeLockedConsumerProject(directory: string, release: string): void {
  const parsedLock: unknown = JSON.parse(fs.readFileSync(path.resolve("package-lock.json"), "utf8"));
  if (!isObject(parsedLock) || parsedLock.lockfileVersion !== 3 || !isObject(parsedLock.packages)) {
    throw new Error("package-lock.json must be a lockfile-v3 package map");
  }

  const rootDescriptor = parsedLock.packages[""];
  if (!isObject(rootDescriptor)) throw new Error("package-lock.json has no root package descriptor");
  const lockedDependencies = stringMap(
    rootDescriptor.dependencies,
    "package-lock.json root dependencies",
  );
  assertSameStringMap(
    lockedDependencies,
    sourceManifest.dependencies,
    "package-lock.json root dependencies",
  );

  const canonicalTarball = fs.realpathSync(release);
  const tarballUrl = pathToFileURL(canonicalTarball).href;
  const integrity = `sha512-${createHash("sha512").update(fs.readFileSync(canonicalTarball)).digest("base64")}`;
  const consumerManifest = {
    name: "picc-packaged-e2e-prefix",
    version: "1.0.0",
    private: true,
    dependencies: { "@arnedeutsch/picc": tarballUrl },
  };
  const packages: Record<string, Record<string, unknown>> = {
    "": {
      name: consumerManifest.name,
      version: consumerManifest.version,
      dependencies: consumerManifest.dependencies,
    },
  };

  for (const [packagePath, descriptor] of Object.entries(parsedLock.packages)) {
    if (packagePath === "") continue;
    if (!isObject(descriptor)) {
      throw new Error(`package-lock.json descriptor ${JSON.stringify(packagePath)} must be an object`);
    }
    if (descriptor.dev !== true) packages[packagePath] = descriptor;
  }

  const piccDescriptor = { ...rootDescriptor };
  delete piccDescriptor.devDependencies;
  packages["node_modules/@arnedeutsch/picc"] = {
    ...piccDescriptor,
    name: sourceManifest.name,
    version: sourceManifest.version,
    resolved: tarballUrl,
    integrity,
  };
  const consumerLock = {
    name: consumerManifest.name,
    version: consumerManifest.version,
    lockfileVersion: 3,
    requires: true,
    packages,
  };

  fs.writeFileSync(path.join(directory, "package.json"), `${JSON.stringify(consumerManifest, null, 2)}\n`);
  fs.writeFileSync(path.join(directory, "package-lock.json"), `${JSON.stringify(consumerLock, null, 2)}\n`);
}

beforeAll(() => {
  tarball = releaseTarball();
  const prefix = temporaryDirectory("picc-packaged-prefix-");
  writeLockedConsumerProject(prefix, tarball);
  const npm = discoverNpmCommand();
  if (!npm) throw new Error("npm is unavailable");
  execFileSync(npm.command, [
    ...npm.args,
    "ci",
    "--offline",
    "--ignore-scripts",
    "--omit=dev",
    "--audit=false",
    "--fund=false",
  ], { cwd: prefix, stdio: "pipe", timeout: 300_000 });
  packageRoot = path.join(prefix, "node_modules", "@arnedeutsch", "picc");
  launcher = path.join(packageRoot, "bin", "picc.mjs");
}, 450_000);

afterEach(cleanup);
afterAll(() => {
  for (const directory of tempDirs) {
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}, 120_000);

it(
  "installed release tarball > commits a local lifecycle in an active linked worktree without runtime egress",
  async () => {
    const project = materializeFixture("full-surface");
    const root = temporaryDirectory("picc-packaged-lifecycle-");
    const lifecycle = createPluginLifecycleFixture(project, root);
    const fixtureSource = path.join(REPO_ROOT, "examples", "full-surface");
    const fixtureBefore = treeSnapshot(fixtureSource);
    const packageBefore = treeSnapshot(packageRoot);
    const runtimeEntrypoint = path.join(packageRoot, "picc", "index.ts");
    const savedRuntimeEntrypoint = fs.readFileSync(runtimeEntrypoint);
    const packagedRuntimeCanary = path.join(root, "packaged-runtime-canary");
    const preloadCanary = path.join(root, "packaged-preload-canary");
    const preloadScript = path.join(root, "packaged-preload-canary.cjs");
    fs.writeFileSync(preloadScript, `require("node:fs").writeFileSync(${JSON.stringify(preloadCanary)}, "executed");\n`);
    let networkAttempts = 0;
    let launches = 0;
    const server = http.createServer((_request, response) => {
      networkAttempts += 1;
      response.writeHead(500).end();
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("network canary did not bind");
    const networkDescriptor = `http://127.0.0.1:${address.port}/must-not-fetch`;
    const run = (args: string[]) => new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      launches += 1;
      execFile(process.execPath, [launcher, "plugin", ...args], {
        cwd: lifecycle.worktree,
        encoding: "utf8",
        env: lifecycleSubprocessEnv({
          HOME: lifecycle.homeDir,
          USERPROFILE: lifecycle.homeDir,
          PICC_CLAUDE_USER_DIR: lifecycle.userDir,
          PI_OFFLINE: "1",
          NODE_OPTIONS: `--require ${JSON.stringify(preloadScript)}`,
        }),
        timeout: 30_000,
      }, (error, stdout, stderr) => {
        if (error && typeof error.code !== "number") {
          reject(error);
          return;
        }
        resolve({ status: error && typeof error.code === "number" ? error.code : 0, stdout, stderr });
      });
    });
    try {
      fs.writeFileSync(runtimeEntrypoint, `import fs from "node:fs"; fs.writeFileSync(${JSON.stringify(packagedRuntimeCanary)}, "executed"); export default function canary() {}\n`);
      const added = await run([
        "marketplace", "add", LIFECYCLE_MARKETPLACE,
        "--source", "local-directory", path.join(lifecycle.project, "lifecycle-marketplace"),
        "--scope", "local", "--yes",
      ]);
      expect(added.status, added.stderr).toBe(0);
      expect(added.stdout).toContain("Marketplace state changed");
      const marketplaceSelector = /Selected marketplace scope\/selector: local; ([A-Za-z0-9_-]+)/u.exec(added.stdout)?.[1];
      expect(marketplaceSelector).toBeDefined();

      const install = (identity: string) => run([
        "install", identity, "--marketplace-selector", marketplaceSelector!, "--scope", "local", "--yes",
      ]);
      const base = await install(LIFECYCLE_BASE_ID);
      expect(base.status, base.stderr).toBe(0);
      expect(base.stdout).toContain("Target scope/record selector: local;");
      expect(base.stdout).toContain("Default/enablement: enabled=true");

      lifecycle.seedImportedCoexistence();
      const importedRecord = path.join(lifecycle.userDir, "plugins", "installed_plugins.json");
      const importedCache = path.join(lifecycle.userDir, "plugins", "cache");
      const importedRecordBefore = fs.readFileSync(importedRecord);
      const importedTreeBefore = treeSnapshot(importedCache);
      fs.writeFileSync(path.join(lifecycle.userDir, "plugins", "known_marketplaces.json"), JSON.stringify({
        foreign: { source: { source: "url", url: networkDescriptor } },
      }));
      const list = await run(["list"]);
      expect(list.status).toBe(0);
      expect(list.stderr).toBe("");
      const pluginBlocks = list.stdout.split(/^Plugin: /mu).slice(1).map((section) => {
        const [identity = "", ...body] = section.split(/\r?\n/u);
        return { identity, body: body.join("\n") };
      });
      const baseBlocks = pluginBlocks.filter((block) => block.identity === LIFECYCLE_BASE_ID);
      expect(baseBlocks).toHaveLength(1);
      expect(baseBlocks[0]!.body).toContain("owner=picc-owned");
      const foreignBlocks = pluginBlocks.filter((block) => block.identity === "imported-visible@foreign");
      expect(foreignBlocks).toHaveLength(1);
      expect(foreignBlocks[0]!.body).toContain("owner=claude-imported-readonly");
      expect(list.stdout).toContain(`Scoped candidate: ${LIFECYCLE_BASE_ID}; scope=user; owner=claude-imported-readonly; read-only`);
      expect(list.stdout).not.toContain(`Plugin: ${LIFECYCLE_BASE_ID}\n  installed: 2`);
      expect(fs.readFileSync(importedRecord)).toEqual(importedRecordBefore);
      expect(treeSnapshot(importedCache)).toEqual(importedTreeBefore);
      expect(importedRecordBefore.toString("utf8")).not.toMatch(/installedAt|lastUpdated|updatedAt/u);

      const operationId = /Operation ID: (plugin_[A-Za-z0-9_-]+)/u.exec(base.stdout)?.[1];
      expect(operationId).toBeDefined();
      const receipt = await run(["recover", operationId!]);
      expect(receipt.status).toBe(0);
      expect(receipt.stderr).toBe("");
      expect(receipt.stdout).toContain(`Operation ID: ${operationId}`);
      expect(receipt.stdout).toContain("Outcome: committed");
      expect(fs.readFileSync(importedRecord)).toEqual(importedRecordBefore);
      expect(treeSnapshot(importedCache)).toEqual(importedTreeBefore);

      const localSettings = path.join(project, ".claude", "settings.local.json");
      expect(JSON.parse(fs.readFileSync(localSettings, "utf8"))).toMatchObject({ enabledPlugins: {
        [LIFECYCLE_BASE_ID]: true,
      } });
      expect(fs.existsSync(path.join(lifecycle.worktree, ".claude", "settings.local.json"))).toBe(false);
      expect(networkDescriptor).toContain("127.0.0.1");
      expect(fs.existsSync(lifecycle.lifecycleTrace)).toBe(false);
      expect(fs.existsSync(lifecycle.runtimeCanary)).toBe(false);
      expect(fs.existsSync(packagedRuntimeCanary)).toBe(false);
      expect(fs.existsSync(preloadCanary)).toBe(false);
    } finally {
      const cleanupErrors: unknown[] = [];
      const cleanupStep = async (step: () => void | Promise<void>) => {
        try { await step(); } catch (error) { cleanupErrors.push(error); }
      };
      await cleanupStep(() => fs.writeFileSync(runtimeEntrypoint, savedRuntimeEntrypoint));
      await cleanupStep(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
      await cleanupStep(() => lifecycle.cleanup());
      await cleanupStep(() => cleanupFixture(project));
      if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, "packaged lifecycle cleanup failed");
    }
    expect(networkAttempts).toBe(0);
    expect(treeSnapshot(packageRoot)).toEqual(packageBefore);
    expect(treeSnapshot(fixtureSource)).toEqual(fixtureBefore);
    expect(launches).toBe(4);
  },
  TEST_TIMEOUT_MS,
);

describe("installed release tarball", () => {
  it.skipIf(!BASH_AVAILABLE)(
    `installs scripts-disabled and runs the packaged launcher through Pi ${expectedPiVersion} with a real Bash child`,
    async () => {
      const parsedInstalledManifest: unknown = JSON.parse(
        fs.readFileSync(path.join(packageRoot, "package.json"), "utf8"),
      );
      if (
        !isObject(parsedInstalledManifest)
        || typeof parsedInstalledManifest.name !== "string"
        || typeof parsedInstalledManifest.version !== "string"
        || !isObject(parsedInstalledManifest.bin)
        || typeof parsedInstalledManifest.bin.picc !== "string"
      ) {
        throw new Error("installed tarball has an invalid packaged-release manifest");
      }
      const installedManifest = {
        name: parsedInstalledManifest.name,
        version: parsedInstalledManifest.version,
        bin: { picc: parsedInstalledManifest.bin.picc },
        dependencies: stringMap(
          parsedInstalledManifest.dependencies,
          "installed tarball dependencies",
        ),
      };
      expect(installedManifest).toMatchObject({
        name: "@arnedeutsch/picc",
        version: sourceManifest.version,
        bin: { picc: "bin/picc.mjs" },
      });
      assertSameStringMap(
        installedManifest.dependencies,
        sourceManifest.dependencies,
        "installed tarball dependencies",
      );
      expect(PI_SUITE_PACKAGES.map((name) => installedManifest.dependencies[name]))
        .toEqual(expectedPiPins);
      expect(new Set(expectedPiPins)).toEqual(new Set([expectedPiVersion]));
      expect(installedManifest.dependencies).not.toHaveProperty("jiti");
      expect(sourceManifest.devDependencies.jiti).toBe("2.7.0");
      expect(fs.readdirSync(packageRoot).sort()).toEqual([
        "CONTRIBUTING.md", "LICENSE", "README.md", "bin", "dist", "doc", "examples",
        "package.json", "picc", "src",
      ]);
      expect(fs.readdirSync(path.join(packageRoot, "picc")).sort()).toEqual(["index.js", "index.ts"]);
      expect(fs.existsSync(path.join(packageRoot, "scripts"))).toBe(false);
      expect(fs.existsSync(path.join(packageRoot, "tsconfig.runtime.json"))).toBe(false);
      const runtimeManifest = JSON.parse(
        fs.readFileSync(path.join(packageRoot, "dist", "picc-runtime.json"), "utf8"),
      ) as {
        entries: { extension: string; pluginInventory: string; mcpAdministration: string };
        files: Array<{ path: string }>;
      };
      expect(runtimeManifest.entries).toEqual({
        extension: "picc/index.js",
        pluginInventory: "dist/plugin-inventory-cli.js",
        mcpAdministration: "dist/mcp-administration-cli.js",
      });
      for (const entry of [
        "dist/index.js",
        "dist/plugin-inventory-cli.js",
        "dist/mcp-administration-cli.js",
      ]) {
        expect(runtimeManifest.files.map((record) => record.path)).toContain(entry);
        expect(runtimeManifest.files.map((record) => record.path)).toContain(`${entry}.map`);
        const sourceMap = JSON.parse(fs.readFileSync(path.join(packageRoot, `${entry}.map`), "utf8")) as Record<string, unknown>;
        expect(sourceMap).not.toHaveProperty("sourcesContent");
      }

      const suite = validatePiSuite({ packageRoot });
      expect(suite).toMatchObject({ ok: true, version: expectedPiVersion });

      const version = execFileSync(process.execPath, [launcher, "--version"], {
        cwd: packageRoot,
        encoding: "utf8",
        timeout: 30_000,
      });
      expect(version).toContain(`PiCC ${sourceManifest.version}`);
      expect(version).toContain(`Embedded Pi ${expectedPiVersion}`);
      expect(version).toContain("Install installed");

      const command = "node -e 'const e=process.env; console.log(JSON.stringify({sessionId:e.PI_SESSION_ID??null,sessionFile:e.PI_SESSION_FILE??null,provider:e.PI_PROVIDER??null,model:e.PI_MODEL??null,reasoning:e.PI_REASONING_LEVEL??null,project:e.CLAUDE_PROJECT_DIR??null,setting:e.PACKAGED_SETTING??null,skip:e.PI_SKIP_VERSION_CHECK??null,launcher:e.PICC_LAUNCHER_PID??null}))'";
      const result = await runPi({
        launcherPath: launcher,
        fixture: "full-surface",
        agent: "selected-main",
        prompt: "run the packaged environment probe",
        script: [
          { toolCalls: [{ name: "bash", args: { command } }] },
          { text: "PACKAGED_EXTENSION_OK" },
        ],
        setup(fixture) {
          const settingsPath = path.join(fixture, ".claude", "settings.json");
          const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
          settings.env = { PACKAGED_SETTING: "configured-value" };
          fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
        },
      });

      expect(result.code, result.stderr).toBe(0);
      expect(result.requests.length).toBeGreaterThanOrEqual(2);
      expect(systemText(result.requests[0]!)).toContain("FS-SELECTED-MAIN-BODY");
      expect(toolNames(result.requests[0]!)).toContain("Agent");
      const bash = toolResultText(result.requests[1]!);
      expect(bash).toContain('"sessionId":null');
      expect(bash).toContain('"sessionFile":null');
      expect(bash).toContain('"provider":null');
      expect(bash).toContain('"model":null');
      expect(bash).toContain('"reasoning":null');
      expect(bash).toContain('"setting":"configured-value"');
      expect(bash).toContain('"skip":null');
      expect(bash).toContain('"launcher":null');
      expect(bash).toContain(`"project":${JSON.stringify(result.fixture)}`);
      expect(result.stdout).toContain("PACKAGED_EXTENSION_OK");
      expect(result.stderr).not.toMatch(/latest-version|api\.openai\.com|anthropic\.com/iu);

      const compiledEntry = path.join(packageRoot, "dist", "index.js");
      const sourceEntry = path.join(packageRoot, "picc", "index.ts");
      const originalCompiled = fs.readFileSync(compiledEntry);
      const originalSource = fs.readFileSync(sourceEntry);
      const sourceCanary = path.join(temporaryDirectory("picc-packaged-tamper-"), "source-executed");
      try {
        fs.appendFileSync(compiledEntry, "\n");
        fs.writeFileSync(
          sourceEntry,
          `import fs from "node:fs"; fs.writeFileSync(${JSON.stringify(sourceCanary)}, "executed"); export default function canary() {}\n`,
        );
        const tampered = await runPi({
          launcherPath: launcher,
          prompt: "must fail before Pi",
          script: [{ text: "PI_MUST_NOT_RUN" }],
        });
        expect(tampered.code).toBe(1);
        expect(tampered.requests).toHaveLength(0);
        expect(tampered.stderr).toContain("installed PiCC runtime is damaged");
        expect(fs.existsSync(sourceCanary)).toBe(false);
      } finally {
        fs.writeFileSync(compiledEntry, originalCompiled);
        fs.writeFileSync(sourceEntry, originalSource);
      }
    },
    TEST_TIMEOUT_MS,
  );
});

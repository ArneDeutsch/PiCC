import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { PI_SUITE_PACKAGES, discoverNpmCommand, validatePiSuite } from "../bin/picc-admin.mjs";
import {
  BASH_AVAILABLE,
  createE2ELive,
  TEST_TIMEOUT_MS,
  toolNames,
  toolResultText,
} from "./helpers/e2e-live.js";

interface SourceManifest {
  name: string;
  version: string;
  bin: { picc: string };
  dependencies: Record<string, string>;
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
  };
}

const { runPi, cleanup } = createE2ELive();
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
    [path.resolve("scripts/pack-release.mjs"), "--output-dir", outputDirectory],
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
    dependencies: { picc: tarballUrl },
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
  packages["node_modules/picc"] = {
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
  if (!BASH_AVAILABLE) return;
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
  packageRoot = path.join(prefix, "node_modules", "picc");
  launcher = path.join(packageRoot, "bin", "picc.mjs");
}, 450_000);

afterEach(cleanup);
afterAll(() => {
  for (const directory of tempDirs) {
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}, 120_000);

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
        name: "picc",
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

      expect(result.code).toBe(0);
      expect(result.requests.length).toBeGreaterThanOrEqual(2);
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
    },
    TEST_TIMEOUT_MS,
  );
});

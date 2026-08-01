import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { PI_SUITE_PACKAGES, discoverNpmCommand, validatePiSuite } from "../bin/picc-admin.mjs";
import {
  BASH_AVAILABLE,
  createE2ELive,
  TEST_TIMEOUT_MS,
  toolNames,
  toolResultText,
} from "./helpers/e2e-live.js";

const { runPi, cleanup } = createE2ELive();
const sourceManifest = JSON.parse(fs.readFileSync(path.resolve("package.json"), "utf8")) as {
  name: string;
  version: string;
  bin: { picc: string };
  dependencies: Record<string, string>;
};
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
  const parsed = JSON.parse(output) as { tarball?: unknown };
  if (typeof parsed.tarball !== "string") throw new Error("pack helper returned no tarball");
  return fs.realpathSync(parsed.tarball);
}

beforeAll(() => {
  if (!BASH_AVAILABLE) return;
  tarball = releaseTarball();
  const prefix = temporaryDirectory("picc-packaged-prefix-");
  fs.writeFileSync(path.join(prefix, "package.json"), JSON.stringify({
    name: "picc-packaged-e2e-prefix",
    version: "1.0.0",
    private: true,
  }));
  const npm = discoverNpmCommand();
  if (!npm) throw new Error("npm is unavailable");
  execFileSync(npm.command, [
    ...npm.args,
    "install",
    "--prefix", prefix,
    tarball,
    "--ignore-scripts",
    "--audit=false",
    "--fund=false",
  ], { cwd: prefix, stdio: "pipe", timeout: 180_000 });
  packageRoot = path.join(prefix, "node_modules", "picc");
  launcher = path.join(packageRoot, "bin", "picc.mjs");
}, 240_000);

afterEach(cleanup);
afterAll(() => {
  for (const directory of tempDirs) {
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

describe("installed release tarball", () => {
  it.skipIf(!BASH_AVAILABLE)(
    `installs scripts-disabled and runs the packaged launcher through Pi ${expectedPiVersion} with a real Bash child`,
    async () => {
      const installedManifest = JSON.parse(
        fs.readFileSync(path.join(packageRoot, "package.json"), "utf8"),
      ) as typeof sourceManifest;
      expect(installedManifest).toMatchObject({
        name: "picc",
        version: sourceManifest.version,
        bin: { picc: "bin/picc.mjs" },
      });
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

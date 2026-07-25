import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { discoverTrustedNpmCli, VALIDATION_MODES, validatePiSuite } from "../bin/picc-admin.mjs";
import {
  BASH_AVAILABLE,
  createE2ELive,
  TEST_TIMEOUT_MS,
  toolNames,
  toolResultText,
} from "./helpers/e2e-live.js";

const { runPi, cleanup } = createE2ELive();
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
  tarball = releaseTarball();
  const prefix = temporaryDirectory("picc-packaged-prefix-");
  fs.writeFileSync(path.join(prefix, "package.json"), JSON.stringify({
    name: "picc-packaged-e2e-prefix",
    version: "1.0.0",
    private: true,
  }));
  const npmCli = discoverTrustedNpmCli();
  if (!npmCli) throw new Error("trusted npm CLI is unavailable");
  execFileSync(process.execPath, [
    npmCli,
    "install",
    "--prefix", prefix,
    tarball,
    "--ignore-scripts",
    "--offline",
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
    "installs scripts-disabled and runs the packaged launcher through Pi 0.82 with a sanitized real Bash child",
    async () => {
      const graph = validatePiSuite({ packageRoot, ...{ mode: VALIDATION_MODES.STRICT_EXACT } });
      expect(graph).toMatchObject({ ok: true, version: "0.82.0", mode: "strict-exact", source: false });

      const version = execFileSync(process.execPath, [launcher, "--version"], {
        cwd: packageRoot,
        encoding: "utf8",
        timeout: 30_000,
      });
      expect(version).toContain("PiCC 0.1.0");
      expect(version).toContain("Embedded Pi 0.82.0 (strict-exact)");
      expect(version).toContain("Install known local package");

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

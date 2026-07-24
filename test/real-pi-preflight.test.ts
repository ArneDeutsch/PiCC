import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  REAL_PI_CLI_RELATIVE_PATH,
  REAL_PI_MISSING_TEST_ENV,
} from "../scripts/resolve-real-pi-cli.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const checkScript = path.join(repoRoot, "scripts", "check-real-pi.mjs");
const missingRoot = path.join(os.tmpdir(), `picc-missing-real-pi-${process.pid}`);
const expectedGuidance = /npm install[\s\S]*@earendil-works\/pi-coding-agent[\s\S]*version supported by package\.json/u;

function output(result: ReturnType<typeof spawnSync>): string {
  return `${result.stdout?.toString() ?? ""}\n${result.stderr?.toString() ?? ""}`;
}

describe("real-Pi package preflight", () => {
  it("fails before the E2E lane with actionable guidance when the CLI is absent", () => {
    const direct = spawnSync(
      process.execPath,
      [checkScript, "--root", missingRoot],
      { cwd: repoRoot, encoding: "utf8" },
    );
    expect(direct.status).not.toBe(0);
    expect(output(direct)).toMatch(expectedGuidance);

    const directoryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "picc-directory-real-pi-"));
    try {
      fs.mkdirSync(path.join(directoryRoot, REAL_PI_CLI_RELATIVE_PATH), { recursive: true });
      const directoryCli = spawnSync(
        process.execPath,
        [checkScript, "--root", directoryRoot],
        { cwd: repoRoot, encoding: "utf8" },
      );
      expect(directoryCli.status).not.toBe(0);
      expect(output(directoryCli)).toMatch(expectedGuidance);
    } finally {
      fs.rmSync(directoryRoot, { recursive: true, force: true });
    }

    const badArgs = spawnSync(
      process.execPath,
      [checkScript, "--unknown"],
      { cwd: repoRoot, encoding: "utf8" },
    );
    expect(badArgs.status).not.toBe(0);
    expect(output(badArgs)).toContain("Usage: node scripts/check-real-pi.mjs [--root <checkout-root>]");

    const npmExecPath = process.env.npm_execpath;
    if (npmExecPath) {
      const installedCli = path.join(repoRoot, REAL_PI_CLI_RELATIVE_PATH);
      expect(fs.statSync(installedCli).isFile()).toBe(true);
      const authoritative = spawnSync(
        process.execPath,
        [npmExecPath, "run", "test:e2e"],
        {
          cwd: repoRoot,
          encoding: "utf8",
          env: { ...process.env, [REAL_PI_MISSING_TEST_ENV]: "1" },
        },
      );
      const authoritativeOutput = output(authoritative);
      expect(authoritative.status).not.toBe(0);
      expect(authoritativeOutput).toContain(installedCli);
      expect(authoritativeOutput).toMatch(expectedGuidance);
      expect(authoritativeOutput).not.toContain("RUN  v");
    }
  });
});

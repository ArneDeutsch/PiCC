import fs from "node:fs";
import path from "node:path";
import picomatch from "picomatch";
import YAML from "yaml";
import { describe, expect, it } from "vitest";
import vitestConfig, { integrationTestFiles } from "../vitest.config.js";

type ProjectConfig = {
  test: {
    name: string;
    include: string[];
    exclude?: string[];
    maxWorkers: number;
    sequence: { groupOrder: number };
  };
};

const expectedIntegrationTestFiles = [
  "test/builtin-agents.test.ts",
  "test/control-commands.test.ts",
  "test/fork-failure-handling.test.ts",
  "test/fork-nested-guard.test.ts",
  "test/fork-sdk-seam.test.ts",
  "test/integration-extension.test.ts",
  "test/lifecycle-wiring.test.ts",
  "test/main-session-only-default.test.ts",
  "test/mcp-registration.test.ts",
  "test/mcp-subagents.test.ts",
  "test/notebook-read-dispatch.test.ts",
  "test/picc-update-repair.test.ts",
  "test/session-replacement-pi-contract.test.ts",
  "test/slashcommand-fork.test.ts",
] as const;

const projects = (vitestConfig as { test: { projects: ProjectConfig[] } }).test.projects;
const project = (name: string) => projects.find((candidate) => candidate.test.name === name)!.test;

function owns(testFile: string, config: ProjectConfig["test"]): boolean {
  return config.include.some((pattern) => picomatch.isMatch(testFile, pattern))
    && !(config.exclude ?? []).some((pattern) => picomatch.isMatch(testFile, pattern));
}

describe("test workflow lanes", () => {
  it("assigns every flat test file to exactly one named project", () => {
    const testFiles = fs.readdirSync(path.resolve("test"))
      .filter((name) => name.endsWith(".test.ts"))
      .map((name) => `test/${name}`)
      .sort();

    expect(projects.map((candidate) => candidate.test.name)).toEqual(["unit", "integration", "e2e"]);
    expect(integrationTestFiles).toEqual(expectedIntegrationTestFiles);
    expect(new Set(integrationTestFiles).size).toBe(integrationTestFiles.length);
    for (const file of integrationTestFiles) {
      expect(file).not.toContain("\\");
      expect(fs.existsSync(path.resolve(file)), file).toBe(true);
    }

    for (const file of testFiles) {
      const owners = projects.filter((candidate) => owns(file, candidate.test));
      expect(owners.map((owner) => owner.test.name), file).toHaveLength(1);
    }

    expect(project("unit").exclude).toEqual([...integrationTestFiles, "test/e2e-*.test.ts"]);
    expect(project("integration").include).toEqual([...integrationTestFiles]);
    expect(project("e2e").include).toEqual(["test/e2e-*.test.ts"]);
    expect(projects.map((candidate) => candidate.test.maxWorkers)).toEqual([2, 2, 2]);
    expect(projects.map((candidate) => candidate.test.sequence.groupOrder)).toEqual([0, 1, 2]);
  });

  it("keeps default commands cheap and complete commands explicit", () => {
    const manifest = JSON.parse(fs.readFileSync(path.resolve("package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    const scripts = manifest.scripts;

    expect(scripts.test).toBe("vitest run --project unit");
    expect(scripts["test:unit"]).toBe("vitest run --project unit");
    expect(scripts["test:integration"]).toBe("vitest run --project integration");
    expect(scripts["test:e2e:compiled"]).toBe(
      "node scripts/check-real-pi.mjs && vitest run --project e2e --exclude \"test/e2e-packaged-launcher.test.ts\" --exclude \"test/e2e-source-fallback.test.ts\"",
    );
    expect(scripts["test:e2e:source-fallback"]).toBe(
      "node scripts/check-real-pi.mjs && vitest run --project e2e test/e2e-source-fallback.test.ts",
    );
    expect(scripts["test:packaged"]).toBe(
      "node scripts/check-real-pi.mjs && vitest run --project e2e test/e2e-packaged-launcher.test.ts",
    );
    expect(scripts["test:e2e"]).toBe(
      "npm run test:packaged && npm run test:e2e:compiled && npm run test:e2e:source-fallback",
    );
    expect(scripts["test:source"]).toBe(
      "npm run test:unit && npm run test:integration && npm run test:e2e:source-fallback",
    );
    expect(scripts["test:all"]).toBe(
      "npm run test:unit && npm run test:integration && npm run test:e2e",
    );
    expect(scripts.verify).toBe("npm run typecheck:all && npm run test:unit");
    expect(scripts["verify:all"]).toBe("npm run typecheck:all && npm run test:all");
    expect(scripts["test:watch"]).toBe("vitest --project unit");

    expect(scripts["test:coverage"]).toBe(
      "vitest run --coverage --project unit --project integration",
    );
    expect(scripts["test:coverage"]).not.toContain("e2e");

    // npm appends focused arguments to these direct Vitest selectors unchanged.
    expect(scripts.test!.split("&&")).toEqual(["vitest run --project unit"]);
    expect(scripts["test:unit"]!.split("&&")).toEqual(["vitest run --project unit"]);
  });

  it("preserves hook isolation while routing pre-commit through the cheap authority", () => {
    const hook = fs.readFileSync(path.resolve(".githooks/pre-commit"), "utf8");
    const activeLines = hook.split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("#"));

    expect(hook.startsWith("#!/bin/sh\n")).toBe(true);
    expect(activeLines).toEqual([
      "unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_PREFIX",
      'echo "pre-commit: npm run verify (unit lane only)"',
      "if ! npm run verify; then",
      'echo "pre-commit: verification failed - commit aborted." >&2',
      "exit 1",
      "fi",
    ]);
    expect(activeLines.slice(
      activeLines.indexOf("if ! npm run verify; then") + 1,
      activeLines.indexOf("fi"),
    )).toContain("exit 1");
    expect(activeLines.join("\n")).not.toMatch(
      /\b(?:verify:all|test:all|test:source|test:integration|test:e2e|check-real-pi)\b|--project\s+(?:integration|e2e)\b/,
    );
    expect(hook).not.toContain("npm install` / `npm ci");
  });

  it("runs unit and integration separately and serializes both e2e products in one OS-matrix job", () => {
    const workflow = YAML.parse(fs.readFileSync(path.resolve(".github/workflows/ci.yml"), "utf8")) as {
      jobs: Record<string, {
        strategy: { matrix: { os: string[]; node?: number[] } };
        steps: Array<{
          name?: string;
          run?: string;
          uses?: string;
          with?: { cache?: string; "node-version"?: number };
          env?: Record<string, string>;
        }>;
      }>;
    };
    expect(Object.keys(workflow.jobs)).toEqual(["test", "e2e"]);
    const matrixJob = workflow.jobs.test!;
    const e2eJob = workflow.jobs.e2e!;

    expect(matrixJob.strategy.matrix).toEqual({
      os: ["ubuntu-latest", "windows-latest"],
      node: [22, 24],
    });
    expect(matrixJob.steps.filter((step) => step.run?.startsWith("npm run test:")))
      .toEqual([
        { name: "Unit tests", run: "npm run test:unit" },
        { name: "Offline integration tests", run: "npm run test:integration" },
      ]);
    expect(e2eJob.strategy.matrix.os).toEqual(["ubuntu-latest", "windows-latest"]);
    expect(e2eJob.steps.filter((step) => step.run?.startsWith("npm run test:")))
      .toEqual([
        { name: "Compiled runtime end-to-end tests", run: "npm run test:e2e:compiled" },
        { name: "Isolated source-fallback end-to-end witness", run: "npm run test:e2e:source-fallback" },
        {
          name: "Scripts-disabled packaged end-to-end witness",
          env: {
            PICC_TEST_TARBALL: "${{ steps.pack.outputs.tarball }}",
            TEMP: "${{ runner.temp }}",
            TMP: "${{ runner.temp }}",
            TMPDIR: "${{ runner.temp }}",
          },
          run: "npm run test:packaged",
        },
      ]);
    const pack = e2eJob.steps.find((step) => step.name === "Build verified runtime and pack exact product once");
    expect(pack?.run).toContain("scripts/pack-release.mjs");
    expect(pack?.run).toContain("--event manual");
    expect(e2eJob.steps.filter((step) => step.run?.includes("scripts/pack-release.mjs"))).toHaveLength(1);
    expect(e2eJob.steps.filter((step) => step.run === "npm ci")).toHaveLength(1);
    expect(e2eJob.steps.filter((step) => step.uses?.startsWith("actions/setup-node@")))
      .toEqual([expect.objectContaining({ with: { "node-version": 22, cache: "npm" } })]);
  });
});

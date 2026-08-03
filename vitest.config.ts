import { defineConfig } from "vitest/config";

export const integrationTestFiles = [
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

export default defineConfig({
  test: {
    testTimeout: 30000,
    hookTimeout: 30000,
    // Git/worktree integration needs process isolation across test files.
    pool: "forks",
    // Vitest 4 keeps coverage at the root; real-Pi children cannot be instrumented here.
    // Coverage is guidance-only and intentionally has no failure thresholds.
    coverage: {
      provider: "v8",
      include: ["src/**"],
      exclude: [
        "test/**",
        "examples/**",
        "scripts/**",
        "dist/**",
        "**/*.config.ts",
      ],
      reporter: ["text", "html"],
      reportsDirectory: "coverage",
    },
    // Every lane can spawn children, so cap workers and serialize increasing-cost groups.
    projects: [
      {
        test: {
          name: "unit",
          include: ["test/**/*.test.ts"],
          exclude: [...integrationTestFiles, "test/e2e-*.test.ts"],
          testTimeout: 30000,
          hookTimeout: 30000,
          pool: "forks",
          maxWorkers: 2,
          sequence: { groupOrder: 0 },
        },
      },
      {
        test: {
          name: "integration",
          include: [...integrationTestFiles],
          testTimeout: 30000,
          hookTimeout: 30000,
          pool: "forks",
          maxWorkers: 2,
          sequence: { groupOrder: 1 },
        },
      },
      {
        test: {
          name: "e2e",
          include: ["test/e2e-*.test.ts"],
          testTimeout: 30000,
          hookTimeout: 30000,
          pool: "forks",
          maxWorkers: 2,
          sequence: { groupOrder: 2 },
        },
      },
    ],
  },
});

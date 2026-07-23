import { defineConfig } from "vitest/config";

/**
 * Two projects share one config so a single `vitest run` covers both lanes:
 *
 *  - `unit`  — everything except the real-Pi e2e files (`**​/e2e-*.test.ts`).
 *  - `e2e`   — the `test/e2e-*.test.ts` files, each of which runs the real Pi
 *              CLI with mock-model infrastructure; subagent scenarios also
 *              spawn nested Pi children.
 *
 * Both projects retain fork parallelism but cap `maxWorkers` at two. Unit tests
 * also include real Git, hook, and MCP children, so bounding each lane limits
 * process multiplication and reduces oversubscription risk on small runners.
 * The cap is the contention lever — we do NOT raise timeouts.
 *
 * `coverage` stays at the config ROOT (it is a root-only option in vitest 4 and
 * instruments only in-process code, i.e. the non-e2e lane); `test:coverage`
 * excludes the e2e files via the CLI.
 */
export default defineConfig({
  test: {
    testTimeout: 30000,
    hookTimeout: 30000,
    // Integration tests create real git repos/worktrees; keep pool forks for isolation.
    pool: "forks",
    coverage: {
      provider: "v8",
      // Report coverage of shipped product code only, not tests/helpers/tooling.
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
      // Guidance signal only — no thresholds, does not fail the build.
    },
    projects: [
      {
        test: {
          name: "unit",
          include: ["test/**/*.test.ts"],
          exclude: ["**/e2e-*.test.ts"],
          testTimeout: 30000,
          hookTimeout: 30000,
          pool: "forks",
          maxWorkers: 2,
        },
      },
      {
        test: {
          name: "e2e",
          include: ["test/e2e-*.test.ts"],
          testTimeout: 30000,
          hookTimeout: 30000,
          pool: "forks",
          // Every e2e file runs a real Pi CLI with mock-model infrastructure;
          // subagent scenarios add nested Pi children, so bounded concurrency
          // keeps the multiplicative process count small.
          // vitest 4 has no per-project (or top-level) `minWorkers`; the cap is
          // `maxWorkers`, which replaced the removed poolOptions.forks.maxForks.
          maxWorkers: 2,
          // Keep the real-Pi lane after the unit lane so their bounded worker
          // pools do not multiply the suite's child-process load.
          sequence: { groupOrder: 1 },
        },
      },
    ],
  },
});

import { defineConfig } from "vitest/config";

/**
 * Two projects share one config so a single `vitest run` covers both lanes:
 *
 *  - `unit`  — everything except the real-Pi e2e files (`**​/e2e-*.test.ts`).
 *  - `e2e`   — the `test/e2e-*.test.ts` files, each of which spawns the real Pi
 *              CLI plus nested subagent children. Their fork count is capped
 *              (`maxWorkers`, vitest 4's replacement for the removed
 *              `poolOptions.forks.maxForks`) so concurrent real-process spawns
 *              never oversubscribe a small CI runner and trip the run-timeout
 *              kill. The cap is the contention lever — we do NOT raise timeouts.
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
        },
      },
      {
        test: {
          name: "e2e",
          include: ["test/e2e-*.test.ts"],
          testTimeout: 30000,
          hookTimeout: 30000,
          pool: "forks",
          // Each e2e file's Pi child spawns more children (subagent Pi + mock
          // server), so real-process count is multiplicative — keep this small.
          // vitest 4 has no per-project (or top-level) `minWorkers`; the cap is
          // `maxWorkers`, which replaced the removed poolOptions.forks.maxForks.
          // Validated on the 2-core CI runner (Phase 9).
          maxWorkers: 2,
          // vitest requires projects with a distinct maxWorkers to run in their
          // own group; a later groupOrder runs the capped e2e lane after the
          // unit lane under a full `vitest run`.
          sequence: { groupOrder: 1 },
        },
      },
    ],
  },
});

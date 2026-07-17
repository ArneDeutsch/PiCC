import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
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
  },
});

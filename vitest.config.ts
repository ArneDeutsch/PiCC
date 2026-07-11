import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 30000,
    hookTimeout: 30000,
    // Integration tests create real git repos/worktrees; keep pool forks for isolation.
    pool: "forks",
  },
});

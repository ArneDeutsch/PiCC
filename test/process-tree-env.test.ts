import { describe, expect, it } from "vitest";
import { processTreeSpawnEnv } from "../src/util/process-tree.js";
import { mcpGitProbeEnv } from "../src/discovery/mcp.js";

const inherited = {
  PATH: "/bin",
  RETAINED: "yes",
  PICC_LAUNCHER_PID: "99",
  PICC_INSTALL_KIND: "source",
  PICC_VERSION: "1.2.3",
  PI_SKIP_VERSION_CHECK: "1",
};

function expectSanitized(env: NodeJS.ProcessEnv): void {
  expect(env.PATH).toBe("/bin");
  expect(env.RETAINED).toBe("yes");
  expect(env.PICC_LAUNCHER_PID).toBeUndefined();
  expect(env.PICC_INSTALL_KIND).toBeUndefined();
  expect(env.PICC_VERSION).toBeUndefined();
  expect(env.PI_SKIP_VERSION_CHECK).toBeUndefined();
}

describe("early helper subprocess environments", () => {
  it("sanitizes the MCP Git-tracked probe environment", () => {
    expectSanitized(mcpGitProbeEnv(inherited));
  });

  it("sanitizes process-tree ps/taskkill environments", () => {
    expectSanitized(processTreeSpawnEnv(inherited));
  });
});

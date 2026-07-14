import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import picc from "../src/index.js";
import { fakePi } from "./helpers/fake-pi.js";
import { cleanupFixture, materializeFixture } from "./helpers/fixture.js";

/**
 * F14 t02 — the `PiccTestSeam.sdk` invariant, guarded (not merely asserted in
 * prose): a SINGLE-arg `picc(pi)` — no `testSeam` — wires NO `deps.sdk`, so the
 * SubagentRuntime falls to `loadRealSdk()`, i.e. it dynamically imports the REAL
 * `@earendil-works/pi-coding-agent` module. There is no env/settings/file
 * fallback anywhere on that path.
 *
 * We mock that real module so `loadRealSdk()` resolves to a controllable SDK
 * whose `createAgentSession` throws a SENTINEL. Driving a fork through the REAL
 * Skill tool of a single-arg `picc(pi)` then surfaces that sentinel — proving the
 * fork reached the real-SDK loader (a fake seam SDK would never touch this
 * module). This test is isolated in its own file so the module mock cannot leak
 * into the injected-fake-SDK consumer tests.
 */

const SENTINEL = "REAL_SDK_SENTINEL_LOADREALSDK_REACHED";

// Partial mock: keep every real export the rest of the codebase relies on
// (defineTool, the tool factories, …) and override ONLY createAgentSession to
// throw — so dispatch's session construction proves it reached this module.
vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    createAgentSession: () => {
      throw new Error(SENTINEL);
    },
  };
});

let dir: string;
const originalCwd = process.cwd();

beforeAll(() => {
  dir = materializeFixture("full-surface");
  const userDir = path.join(dir, ".claude-user");
  fs.mkdirSync(userDir, { recursive: true });
  process.env.PICC_CLAUDE_USER_DIR = userDir;
  process.chdir(dir);
});

afterAll(() => {
  process.chdir(originalCwd);
  cleanupFixture(dir);
});

describe("F14 t02 — sdk seam invariant", () => {
  it("single-arg picc(pi) (no testSeam) uses the real-sdk path (loadRealSdk), never a smuggled fake", async () => {
    const p = fakePi();
    picc(p.api as never); // NO second argument — no seam sdk
    const skillTool = p.tools.get("Skill");
    const err = await skillTool
      .execute("seam", { name: "fork-research", arguments: "x" })
      .catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    // dispatch's catch-all wraps the createAgentSession throw; the sentinel proves
    // the fork went through loadRealSdk → the (mocked) real module.
    expect((err as Error).message).toContain(SENTINEL);
  });
});

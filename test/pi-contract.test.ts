import { describe, expect, it } from "vitest";

/**
 * Pi upstream contract smoke test (design doc §4): asserts every Pi API PiCC
 * builds on exists in the pinned version. If Pi churns, this fails first and loudly.
 */
describe("pi 0.80.x API contract", () => {
  it("exports the SDK surface PiCC uses", async () => {
    const sdk: Record<string, unknown> = await import("@earendil-works/pi-coding-agent");
    for (const name of [
      "createAgentSession",
      "DefaultResourceLoader",
      "SessionManager",
      "SettingsManager",
      "AuthStorage",
      "ModelRegistry",
      "defineTool",
      "createBashTool",
      "createReadTool",
      "createWriteTool",
      "createEditTool",
      "createGrepTool",
      "createFindTool",
      "createLsTool",
      "truncateHead",
      "truncateTail",
      "CONFIG_DIR_NAME",
    ]) {
      expect(sdk[name], `missing pi export: ${name}`).toBeDefined();
    }
  });

  it("SessionManager/SettingsManager expose in-memory factories", async () => {
    const sdk: any = await import("@earendil-works/pi-coding-agent");
    expect(typeof sdk.SessionManager.inMemory).toBe("function");
    expect(typeof sdk.SettingsManager.inMemory).toBe("function");
  });

  it("typebox + StringEnum are importable the way our tools use them", async () => {
    const { Type } = await import("typebox");
    const { StringEnum } = await import("@earendil-works/pi-ai");
    expect(typeof Type.Object).toBe("function");
    expect(typeof StringEnum).toBe("function");
  });

  it("type pins compile against the pinned Pi: stopReason/errorMessage on AssistantMessage, 5-arg execute (t01)", async () => {
    // vitest strips types without checking them and the project tsconfig
    // excludes test/, so the pins live in test/helpers/pi-contract-pins.ts and
    // are compiled HERE with the real TypeScript checker — Pi type churn fails
    // this test with the actual tsc diagnostics.
    const { createRequire } = await import("node:module");
    const { execFileSync } = await import("node:child_process");
    const path = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const require = createRequire(import.meta.url);
    const tscBin = path.join(path.dirname(require.resolve("typescript/package.json")), "bin", "tsc");
    const pinsConfig = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "helpers",
      "pi-contract-pins.tsconfig.json",
    );
    let output = "";
    let failed = false;
    try {
      output = execFileSync(process.execPath, [tscBin, "-p", pinsConfig], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      failed = true;
      const e = err as { stdout?: string; stderr?: string; message: string };
      output = `${e.stdout ?? ""}\n${e.stderr ?? ""}\n${e.message}`;
    }
    expect(failed, `Pi type contract broken:\n${output}`).toBe(false);
  }, 30_000);
});

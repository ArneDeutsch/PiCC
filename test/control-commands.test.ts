import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import picc from "../src/index.js";
import { fakePi, type FakePi } from "./helpers/fake-pi.js";
import { cleanupFixture, materializeFixture } from "./helpers/fixture.js";

/**
 * Control commands must NEVER leak to the model. In non-interactive modes Pi's
 * own command router does not intercept `/skills` `/agents` etc. before the input
 * event, so the extension's `input` handler has to catch them, render output, and
 * short-circuit with { action: "handled" } — never producing a turn.
 *
 * This is the deterministic offline form of e2e scenario 10 (print-mode arg
 * mangling makes the live-CLI form flaky): it fires the input event directly
 * through a fake Pi API and asserts the handler answers without reaching a model.
 */

let dir: string;
let pi: FakePi;
const originalCwd = process.cwd();
const savedUserDir = process.env.PICC_CLAUDE_USER_DIR;

beforeAll(async () => {
  dir = materializeFixture("full-surface");
  // Hermetic user scope: don't absorb the developer's real ~/.claude.
  const userDir = path.join(dir, ".claude-user");
  fs.mkdirSync(userDir, { recursive: true });
  process.env.PICC_CLAUDE_USER_DIR = userDir;
  process.chdir(dir);
  pi = fakePi();
  picc(pi.api as never);
  // built-in overrides register via an async IIFE — give it a beat
  await new Promise((r) => setTimeout(r, 500));
});

afterAll(() => {
  process.chdir(originalCwd);
  if (savedUserDir === undefined) delete process.env.PICC_CLAUDE_USER_DIR;
  else process.env.PICC_CLAUDE_USER_DIR = savedUserDir;
  cleanupFixture(dir);
});

describe("control commands never leak to the model", () => {
  it("/skills is handled by the input event and emits a picc-skills message", async () => {
    pi.messages.length = 0;
    const outcome = await pi.fire("input", { text: "/skills", source: "interactive" });

    // Short-circuited: the handler answered instead of producing a model turn.
    expect(outcome).toEqual({ action: "handled" });

    const skillsMsg = pi.messages.find((m) => m.message?.customType === "picc-skills");
    expect(skillsMsg, "expected a picc-skills message").toBeDefined();
    const content = String(skillsMsg?.message?.content ?? "");
    expect(content).toContain("skill(s) loaded");
    expect(content).toContain("/deploy");
  });

  it("/agents is handled and emits a picc-agents message", async () => {
    pi.messages.length = 0;
    const outcome = await pi.fire("input", { text: "/agents", source: "interactive" });

    expect(outcome).toEqual({ action: "handled" });
    const agentsMsg = pi.messages.find((m) => m.message?.customType === "picc-agents");
    expect(agentsMsg, "expected a picc-agents message").toBeDefined();
    expect(String(agentsMsg?.message?.content ?? "")).toContain("reviewer");
  });

  it("does not treat a real skill slash command as a control command (it transforms)", async () => {
    // Contrast: /deploy is a project skill, so it expands into a model turn
    // rather than being short-circuited as a control command.
    const outcome = await pi.fire("input", { text: "/deploy staging 1.0", source: "interactive" });
    expect(outcome.action).toBe("transform");
    expect(String(outcome.text ?? "")).toContain("FS-SKILL-ARGS-BODY");
  });
});

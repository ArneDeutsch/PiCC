import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import picc from "../src/index.js";
import { fakePi, type FakePi } from "./helpers/fake-pi.js";
import { cleanupFixture, materializeFixture } from "./helpers/fixture.js";

/**
 * Control commands must display their output IMMEDIATELY and must NEVER leak
 * to the model.
 *
 * Regression guard: the first implementation delivered control output via
 * pi.sendMessage({...}, { deliverAs: "nextTurn" }) — Pi queues such messages
 * for the NEXT user prompt, so running /doctor appeared to do nothing (and the
 * report was silently injected into the model's context one turn later). The
 * fix renders a TUI-only custom entry (pi.appendEntry + registerEntryRenderer),
 * which shows up in the transcript right away and never enters LLM context.
 *
 * Two paths produce the output and must behave identically:
 *  - interactive mode: Pi's command router calls the registered command handler
 *  - all other modes: the `input` event handler catches the command and
 *    short-circuits with { action: "handled" } — never producing a turn.
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

function reset() {
  pi.messages.length = 0;
  pi.entries.length = 0;
}

function controlEntry(command: string) {
  return pi.entries.find((e) => e.customType === "picc-control" && e.data?.command === command);
}

describe("control commands display immediately and never leak to the model", () => {
  it("/skills via the input event renders a picc-control entry and short-circuits", async () => {
    reset();
    const outcome = await pi.fire("input", { text: "/skills", source: "interactive" });

    // Short-circuited: the handler answered instead of producing a model turn.
    expect(outcome).toEqual({ action: "handled" });

    const entry = controlEntry("skills");
    expect(entry, "expected a picc-control entry for /skills").toBeDefined();
    const output = String(entry?.data?.output ?? "");
    expect(output).toContain("skill(s) loaded");
    expect(output).toContain("/deploy");

    // Control output is user-facing status — it must never enter LLM context.
    expect(pi.messages).toHaveLength(0);
  });

  it("/agents via the input event renders a picc-control entry", async () => {
    reset();
    const outcome = await pi.fire("input", { text: "/agents", source: "interactive" });

    expect(outcome).toEqual({ action: "handled" });
    const entry = controlEntry("agents");
    expect(entry, "expected a picc-control entry for /agents").toBeDefined();
    expect(String(entry?.data?.output ?? "")).toContain("reviewer");
    expect(pi.messages).toHaveLength(0);
  });

  it("/usage via the input event is intercepted (print/non-interactive mode) and never leaks to the model", async () => {
    // Regression guard (t07 FIX 3): /usage was registered as a command but MISSING
    // from the input-handler control-command interceptor, so in print mode it fell
    // through to the model instead of being short-circuited.
    reset();
    const outcome = await pi.fire("input", { text: "/usage", source: "print" });

    expect(outcome).toEqual({ action: "handled" });
    const entry = controlEntry("usage");
    expect(entry, "expected a picc-control entry for /usage").toBeDefined();
    expect(String(entry?.data?.output ?? "")).toContain("subagent");
    expect(pi.messages, "/usage must not leak to the model").toHaveLength(0);
  });

  it("/doctor via the registered command handler displays immediately (regression: was queued for the next turn)", async () => {
    reset();
    const command = pi.commands.get("doctor");
    expect(command, "expected a registered /doctor command").toBeDefined();

    await command.handler("", pi.ctx());

    const entry = controlEntry("doctor");
    expect(entry, "expected a picc-control entry appended synchronously").toBeDefined();
    expect(String(entry?.data?.output ?? "")).toContain("PiCC compatibility report");
    // Nothing queued as a (deferred) LLM message.
    expect(pi.messages).toHaveLength(0);
  });

  it("every control command is registered and produces immediate entry output", async () => {
    for (const name of ["doctor", "compat", "quota", "skills", "agents", "usage"]) {
      reset();
      const command = pi.commands.get(name);
      expect(command, `expected /${name} to be registered`).toBeDefined();
      await command.handler("", pi.ctx());
      expect(controlEntry(name), `expected /${name} to append a picc-control entry`).toBeDefined();
      expect(pi.messages, `/${name} must not send LLM-context messages`).toHaveLength(0);
    }
  });

  it("the picc-control entry renderer turns an entry into visible lines", () => {
    const renderer = pi.entryRenderers.get("picc-control");
    expect(renderer, "expected an entry renderer for picc-control").toBeDefined();

    const theme = { fg: (_color: string, text: string) => text };
    const component = renderer!(
      { data: { command: "doctor", output: "first line\nsecond line" } },
      { expanded: false },
      theme,
    );
    const lines: string[] = component.render(80);
    expect(lines[0]).toContain("/doctor");
    expect(lines).toContain("first line");
    expect(lines).toContain("second line");
  });

  it("the picc-compat entry renderer renders the startup notice", () => {
    const renderer = pi.entryRenderers.get("picc-compat");
    expect(renderer, "expected an entry renderer for picc-compat").toBeDefined();

    const theme = { fg: (_color: string, text: string) => text };
    const component = renderer!({ data: { notice: "4 feature(s) degraded" } }, { expanded: false }, theme);
    const lines: string[] = component.render(80);
    expect(lines.join("\n")).toContain("4 feature(s) degraded");
  });

  it("does not treat a real skill slash command as a control command (it transforms)", async () => {
    // Contrast: /deploy is a project skill, so it expands into a model turn
    // rather than being short-circuited as a control command.
    const outcome = await pi.fire("input", { text: "/deploy staging 1.0", source: "interactive" });
    expect(outcome.action).toBe("transform");
    expect(String(outcome.text ?? "")).toContain("FS-SKILL-ARGS-BODY");
  });
});

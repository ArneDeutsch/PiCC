import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import picc from "../src/index.js";
import type { PiSdk } from "../src/runtime/subagents.js";
import { fakePi, type FakePi } from "./helpers/fake-pi.js";
import { fakeSdk, type FakeSessionState } from "./helpers/fake-sdk.js";
import { cleanupFixture, materializeFixture } from "./helpers/fixture.js";

/**
 * F14 t02 — offline-integration for the `context: fork` failure/abort path.
 *
 * Drives the REAL fork consumers (the Skill tool's `execute` and the top-level
 * input-hook expansion) through a controllable dispatch outcome. A fresh
 * `wire()`d extension instance receives an injected fake Pi SDK via the in-process
 * `PiccTestSeam.sdk` field, so a fork runs fully offline (no LLM/network) and the
 * test scripts each terminal outcome — completed / failed-with-partial /
 * failed-no-output / aborted — the way real Pi surfaces it (a stopReason on the
 * last assistant message; abort resolved through the never-settling gate).
 *
 * The `fork-research` fixture skill (`context: fork`, `agent: researcher`) is both
 * model-invocable (Skill tool) and `/`-invocable (input hook), so it exercises
 * both consumers.
 */

let dir: string;
const originalCwd = process.cwd();

beforeAll(() => {
  dir = materializeFixture("full-surface");
  // Hermetic user scope: don't absorb the developer's real ~/.claude.
  const userDir = path.join(dir, ".claude-user");
  fs.mkdirSync(userDir, { recursive: true });
  process.env.PICC_CLAUDE_USER_DIR = userDir;
  process.chdir(dir);
});

afterAll(() => {
  process.chdir(originalCwd);
  cleanupFixture(dir);
});

/**
 * A FRESH extension instance with an injected fake SDK — never the outer
 * `beforeAll` pi (whose runtime lazy-loads the real SDK). The seam sdk reaches
 * every dispatch, including forks that close over the one runtime instance.
 */
function wire(sdk: PiSdk): FakePi {
  const p = fakePi();
  picc(p.api as never, { sdk });
  return p;
}

/** Pushes a partial assistant turn then a terminal API-error turn (parity fixture). */
function partialThenApiDeath(errorMessage: string) {
  return (_text: string, s: FakeSessionState) => {
    s.messages.push({
      role: "assistant",
      content: [{ type: "text", text: "partial research findings" }],
      stopReason: "toolUse",
    });
    s.messages.push({ role: "assistant", content: [], stopReason: "error", errorMessage });
  };
}

const API_DEATH = /Agent terminated early due to an API error/;

describe("F14 t02 — Skill-tool fork consumer", () => {
  it("(1) failed WITH partial output → success-shaped content: partial preserved + cut-off note names the cause", async () => {
    const h = fakeSdk({ onPrompt: partialThenApiDeath("503 upstream unavailable") });
    const skillTool = wire(h.sdk).tools.get("Skill");
    const res = await skillTool.execute("s1", { name: "fork-research", arguments: "wasm abi" });
    const text = res.content[0].text as string;
    expect(text.startsWith("partial research findings")).toBe(true);
    expect(text).toMatch(API_DEATH);
    expect(text).toContain("503 upstream unavailable");
    expect(text).toContain("\n\n---\n"); // the t01 cut-off frame (byte-identical, not hand-written here)
    expect(res.details.cutOff).toBe(true);
    expect(res.details.forked).toBe(true);
    expect(res.details.agent).toBeTruthy(); // the fork's identity survives on the partial path
  });

  it("(2) failed with NO output → throws the named cause, no fabricated cut-off frame", async () => {
    const h = fakeSdk({
      replies: [{ stopReason: "error", errorMessage: "insufficient_quota: usage drained" }],
    });
    const skillTool = wire(h.sdk).tools.get("Skill");
    const err = await skillTool
      .execute("s2", { name: "fork-research", arguments: "x" })
      .catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(
      /Agent terminated early due to an API error: .*insufficient_quota/,
    );
    expect((err as Error).message).not.toContain("---"); // no fabricated partial frame
  });

  it("(3) Esc aborts the fork → abort wording (proves the signal threads execute→forkDispatch→dispatch)", async () => {
    const gate = new Promise<void>(() => {}); // never resolves — only abort ends it
    const h = fakeSdk({ replies: [{ text: "never delivered", gate }] });
    const skillTool = wire(h.sdk).tools.get("Skill");
    const controller = new AbortController();
    // Pi passes the Esc signal positionally as the 3rd execute arg.
    const pending = skillTool.execute(
      "s3",
      { name: "fork-research", arguments: "x" },
      controller.signal,
    );
    const guarded = pending.catch((e: Error) => e);
    await new Promise((r) => setTimeout(r, 10)); // let the prompt start and block on the gate
    controller.abort();
    const err = await guarded;
    expect(err).toBeInstanceOf(Error);
    // Assert on the ABORT wording, not the synthetic fork:<skill> agent name.
    expect((err as Error).message).toContain("aborted");
    expect((err as Error).message).not.toMatch(API_DEATH); // distinct from the API-error wording
    expect(h.abortCalls()).toBeGreaterThan(0); // signal reached the live session's abort()
  });

  it("(4) successful fork → verbatim final message (unchanged), not cut off", async () => {
    const h = fakeSdk({ replies: ["- bullet one\n- bullet two\n- bullet three"] });
    const skillTool = wire(h.sdk).tools.get("Skill");
    const res = await skillTool.execute("s4", { name: "fork-research", arguments: "x" });
    expect(res.content[0].text).toBe("- bullet one\n- bullet two\n- bullet three");
    expect(res.details.forked).toBe(true);
    expect(res.details.agent).toBeTruthy();
    // cutOff:false here because forks are non-resumable, so the completed branch never
    // trailers regardless of allowResumeTrailer — trailer behaviour is unit-covered in t01.
    expect(res.details.cutOff).toBe(false);
  });
});

describe("F14 — SlashCommand-tool fork consumer (shares runSkillActivation with the Skill tool)", () => {
  it("(8) failed WITH partial output → partial preserved + cause named", async () => {
    const h = fakeSdk({ onPrompt: partialThenApiDeath("503 upstream unavailable") });
    const slashTool = wire(h.sdk).tools.get("SlashCommand");
    const res = await slashTool.execute("c1", { command: "/fork-research wasm abi" });
    const text = res.content[0].text as string;
    expect(text.startsWith("partial research findings")).toBe(true);
    expect(text).toMatch(API_DEATH);
    expect(text).toContain("503 upstream unavailable");
    expect(res.details.cutOff).toBe(true);
    expect(res.details.forked).toBe(true);
  });

  it("(9) Esc aborts the fork → abort wording (signal threads SlashCommand→runSkillActivation→dispatch)", async () => {
    const gate = new Promise<void>(() => {}); // never resolves — only abort ends it
    const h = fakeSdk({ replies: [{ text: "never delivered", gate }] });
    const slashTool = wire(h.sdk).tools.get("SlashCommand");
    const controller = new AbortController();
    const guarded = slashTool
      .execute("c2", { command: "/fork-research x" }, controller.signal)
      .catch((e: Error) => e);
    await new Promise((r) => setTimeout(r, 10));
    controller.abort();
    const err = await guarded;
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("aborted");
    expect((err as Error).message).not.toMatch(API_DEATH);
    expect(h.abortCalls()).toBeGreaterThan(0);
  });
});

describe("F14 t02 — input-hook fork consumer (/fork-research …)", () => {
  it("(5) failed WITH partial output → transform text folds the partial AND the cause (success envelope kept)", async () => {
    const h = fakeSdk({ onPrompt: partialThenApiDeath("503 upstream unavailable") });
    const p = wire(h.sdk);
    const out = await p.fire("input", { text: "/fork-research wasm abi", source: "interactive" });
    expect(out.action).toBe("transform");
    expect(out.text).toContain("ran in a forked subagent"); // success envelope preserved for a cut-off result
    expect(out.text).toContain("partial research findings");
    expect(out.text).toMatch(API_DEATH);
    expect(out.text).toContain("503 upstream unavailable");
  });

  it("(6) failed with NO output → text names the cause and the expansion STILL happens (handler never throws)", async () => {
    const h = fakeSdk({
      replies: [{ stopReason: "error", errorMessage: "insufficient_quota: usage drained" }],
    });
    const p = wire(h.sdk);
    const out = await p.fire("input", { text: "/fork-research x", source: "interactive" });
    expect(out.action).toBe("transform"); // did not throw → did not fall through to `continue`
    expect(out.text).toContain("did not finish");
    expect(out.text).toContain("insufficient_quota");
    expect(out.text).not.toContain("/fork-research"); // NOT the raw unexpanded slash command
  });

  it("(7) successful fork → success envelope with the verbatim result (unchanged)", async () => {
    const h = fakeSdk({ replies: ["- a\n- b\n- c"] });
    const p = wire(h.sdk);
    const out = await p.fire("input", { text: "/fork-research x", source: "interactive" });
    expect(out.action).toBe("transform");
    expect(out.text).toContain("The fork-research skill ran in a forked subagent. Its result:");
    expect(out.text).toContain("- a\n- b\n- c");
  });

  it("(8) Esc during a typed /forked-skill aborts it (interactive onTerminalInput watch)", async () => {
    // The typed route has no ctx.signal (fires before the turn streams); in TUI
    // mode the input hook subscribes to raw terminal input and aborts its own
    // controller on a bare Esc byte. This proves that wiring end-to-end: a
    // simulated Esc cancels the in-flight fork and the turn still expands (aborted),
    // never leaking the raw /fork-research to the model.
    const ESC = String.fromCharCode(0x1b);
    const gate = new Promise<void>(() => {}); // never resolves — only abort ends it
    const h = fakeSdk({ replies: [{ text: "never delivered", gate }] });
    const p = wire(h.sdk);
    let escHandler: ((data: string) => unknown) | undefined;
    let unsubscribed = false;
    const ctx = p.ctx({
      mode: "tui",
      signal: undefined,
      ui: {
        notify: () => {},
        setStatus: () => {},
        onTerminalInput: (handler: (data: string) => unknown) => {
          escHandler = handler;
          return () => {
            unsubscribed = true;
          };
        },
      },
    });
    const pending = p.fire("input", { text: "/fork-research x", source: "interactive" }, ctx);
    pending.catch(() => {}); // avoid an unhandled-rejection warning while we poll
    // Poll until the hook subscribes (the input-hook path has more awaits before
    // the fork than the direct execute path, so a fixed short sleep is flaky).
    for (let i = 0; i < 200 && !escHandler; i++) await new Promise((r) => setTimeout(r, 5));
    expect(escHandler).toBeDefined();
    // An arrow key (ESC-prefixed sequence) must NOT cancel — only a lone Esc.
    expect(escHandler!(`${ESC}[A`)).toBeUndefined(); // not consumed, no abort
    expect(h.abortCalls()).toBe(0); // the arrow sequence did not abort the fork
    const consumed = escHandler!(ESC); // user presses Esc
    expect(consumed).toEqual({ consume: true });
    const out = await pending;
    expect(out.action).toBe("transform");
    expect(out.text).toContain("did not finish");
    expect(out.text).toContain("aborted");
    expect(out.text).not.toContain("/fork-research"); // no raw-input fallback
    expect(h.abortCalls()).toBeGreaterThan(0);
    expect(unsubscribed).toBe(true); // watcher cleaned up in finally
  });
});

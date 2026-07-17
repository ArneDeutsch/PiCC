import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import picc from "../src/index.js";
import type { PiSdk } from "../src/runtime/subagents.js";
import { fakePi, type FakePi } from "./helpers/fake-pi.js";
import { fakeSdk, type FakeSessionState } from "./helpers/fake-sdk.js";
import { cleanupFixture, materializeFixture } from "./helpers/fixture.js";
import { deferred, waitUntil } from "./helpers/async.js";

/**
 * Offline-integration for the `context: fork` failure/abort path.
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
async function wire(sdk: PiSdk): Promise<FakePi> {
  const p = fakePi();
  picc(p.api as never, { sdk, onInitializationSettled: p.captureInitialization });
  await p.waitForInitialization();
  await p.waitForTools(["bash", "read", "write", "edit", "grep", "find", "ls"]);
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

describe("Skill-tool fork consumer", () => {
  it("(1) failed WITH partial output → success-shaped content: partial preserved + cut-off note names the cause", async () => {
    const h = fakeSdk({ onPrompt: partialThenApiDeath("503 upstream unavailable") });
    const skillTool = (await wire(h.sdk)).tools.get("Skill");
    const res = await skillTool.execute("s1", { name: "fork-research", arguments: "wasm abi" });
    const text = res.content[0].text as string;
    expect(text.startsWith("partial research findings")).toBe(true);
    expect(text).toMatch(API_DEATH);
    expect(text).toContain("503 upstream unavailable");
    expect(text).toContain("\n\n---\n"); // the cut-off frame (byte-identical, not hand-written here)
    expect(res.details.cutOff).toBe(true);
    expect(res.details.forked).toBe(true);
    expect(res.details.agent).toBeTruthy(); // the fork's identity survives on the partial path
  });

  it("(2) failed with NO output → throws the named cause, no fabricated cut-off frame", async () => {
    const h = fakeSdk({
      replies: [{ stopReason: "error", errorMessage: "insufficient_quota: usage drained" }],
    });
    const skillTool = (await wire(h.sdk)).tools.get("Skill");
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
    const skillTool = (await wire(h.sdk)).tools.get("Skill");
    const controller = new AbortController();
    // Pi passes the Esc signal positionally as the 3rd execute arg.
    const pending = skillTool.execute(
      "s3",
      { name: "fork-research", arguments: "x" },
      controller.signal,
    );
    const guarded = pending.catch((e: Error) => e);
    await h.waitForPromptCalls(1); // prove the signal targets the live gated prompt
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
    const skillTool = (await wire(h.sdk)).tools.get("Skill");
    const res = await skillTool.execute("s4", { name: "fork-research", arguments: "x" });
    expect(res.content[0].text).toBe("- bullet one\n- bullet two\n- bullet three");
    expect(res.details.forked).toBe(true);
    expect(res.details.agent).toBeTruthy();
    // cutOff:false here because forks are non-resumable, so the completed branch never
    // trailers regardless of allowResumeTrailer — trailer behaviour is unit-covered elsewhere.
    expect(res.details.cutOff).toBe(false);
  });
});

describe("SlashCommand-tool fork consumer (shares runSkillActivation with the Skill tool)", () => {
  // The partial-output / no-output outcomes are proven verbatim by the Skill-tool
  // matrix above (SlashCommand shares runSkillActivation), so only the distinct
  // abort path — Esc threaded through SlashCommand.execute's positional 3rd arg —
  // is retained here as this surface's representative.
  it("(9) Esc aborts the fork → abort wording (signal threads SlashCommand→runSkillActivation→dispatch)", async () => {
    const gate = new Promise<void>(() => {}); // never resolves — only abort ends it
    const h = fakeSdk({ replies: [{ text: "never delivered", gate }] });
    const slashTool = (await wire(h.sdk)).tools.get("SlashCommand");
    const controller = new AbortController();
    const guarded = slashTool
      .execute("c2", { command: "/fork-research x" }, controller.signal)
      .catch((e: Error) => e);
    await h.waitForPromptCalls(1); // prove the signal targets the live gated prompt
    controller.abort();
    const err = await guarded;
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("aborted");
    expect((err as Error).message).not.toMatch(API_DEATH);
    expect(h.abortCalls()).toBeGreaterThan(0);
  });
});

describe("input-hook fork consumer (/fork-research …)", () => {
  it("(5) failed WITH partial output → transform text folds the partial AND the cause (success envelope kept)", async () => {
    const h = fakeSdk({ onPrompt: partialThenApiDeath("503 upstream unavailable") });
    const p = await wire(h.sdk);
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
    const p = await wire(h.sdk);
    const out = await p.fire("input", { text: "/fork-research x", source: "interactive" });
    expect(out.action).toBe("transform"); // did not throw → did not fall through to `continue`
    expect(out.text).toContain("did not finish");
    expect(out.text).toContain("insufficient_quota");
    expect(out.text).not.toContain("/fork-research"); // NOT the raw unexpanded slash command
  });

  it("(7) successful fork → success envelope with the verbatim result (unchanged)", async () => {
    const h = fakeSdk({ replies: ["- a\n- b\n- c"] });
    const p = await wire(h.sdk);
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
    const p = await wire(h.sdk);
    let escHandler: ((data: string) => unknown) | undefined;
    const handlerInstalled = deferred<void>();
    let unsubscribed = false;
    const ctx = p.ctx({
      mode: "tui",
      signal: undefined,
      ui: {
        notify: () => {},
        setStatus: () => {},
        onTerminalInput: (handler: (data: string) => unknown) => {
          escHandler = handler;
          handlerInstalled.resolve();
          return () => {
            unsubscribed = true;
          };
        },
      },
    });
    const pending = p.fire("input", { text: "/fork-research x", source: "interactive" }, ctx);
    pending.catch(() => {}); // guard while the event-driven readiness waits run
    await waitUntil({
      description: "typed slash input to install its terminal-input handler",
      predicate: () => handlerInstalled.promise.then(() => true),
      describeObserved: () => `handler installed: ${escHandler !== undefined}`,
    });
    const installedHandler = escHandler;
    expect(installedHandler).toBeDefined();
    // An arrow key (ESC-prefixed sequence) must NOT cancel — only a lone Esc.
    expect(installedHandler!(`${ESC}[A`)).toBeUndefined(); // not consumed, no abort
    expect(h.abortCalls()).toBe(0); // the arrow sequence did not abort the fork
    await h.waitForPromptCalls(1); // bare Esc must cancel a live fork, not pre-start work
    const consumed = installedHandler!(ESC); // user presses Esc
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

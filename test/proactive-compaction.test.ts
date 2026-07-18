import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import picc from "../src/index.js";
import {
  PROACTIVE_COOLDOWN_TURNS,
  PROACTIVE_PENDING_MAX_TURNS,
  decideProactiveCompaction,
  initialPendingState,
  pendingStateAfterCompaction,
  type ProactivePendingState,
} from "../src/runtime/proactive-compaction.js";
import { fakePi, type FakePi } from "./helpers/fake-pi.js";

// A usage shape at/around the threshold; percent is on the 0–100 scale.
const usageAt = (percent: number | null) => ({ tokens: 100, contextWindow: 1000, percent });

describe("decideProactiveCompaction (pure decision)", () => {
  const fresh = () => initialPendingState();

  it("does not compact below threshold", () => {
    const d = decideProactiveCompaction(usageAt(84.9), 85, fresh());
    expect(d.compact).toBe(false);
    expect(d.pending.pending).toBe(false);
  });

  it("compacts at exactly the threshold and sets the pending flag", () => {
    const d = decideProactiveCompaction(usageAt(85), 85, fresh());
    expect(d.compact).toBe(true);
    expect(d.pending.pending).toBe(true);
    expect(d.pending.turnsRemaining).toBe(PROACTIVE_PENDING_MAX_TURNS);
  });

  it("compacts above threshold", () => {
    expect(decideProactiveCompaction(usageAt(99.2), 85, fresh()).compact).toBe(true);
  });

  it("does not compact and does not throw on undefined usage", () => {
    const d = decideProactiveCompaction(undefined, 85, fresh());
    expect(d.compact).toBe(false);
  });

  it("does not compact on null percent (post-compaction window)", () => {
    const d = decideProactiveCompaction(usageAt(null), 85, fresh());
    expect(d.compact).toBe(false);
  });

  it("does not compact on a partial ctx shape (percent absent, tokens null)", () => {
    expect(decideProactiveCompaction({ tokens: 1234 } as any, 85, fresh()).compact).toBe(false);
    expect(decideProactiveCompaction({ tokens: null } as any, 85, fresh()).compact).toBe(false);
    expect(decideProactiveCompaction({} as any, 85, fresh()).compact).toBe(false);
  });

  it("anti-thrash: does not compact again while pending, even above threshold", () => {
    const first = decideProactiveCompaction(usageAt(90), 85, fresh());
    expect(first.compact).toBe(true);
    const second = decideProactiveCompaction(usageAt(90), 85, first.pending);
    expect(second.compact).toBe(false);
    expect(second.pending.pending).toBe(true);
  });

  it("anti-thrash cleared on success: a fresh (cleared) state re-triggers", () => {
    // `session_compact` success resets to initialPendingState() in the handler.
    const d = decideProactiveCompaction(usageAt(90), 85, initialPendingState());
    expect(d.compact).toBe(true);
  });

  it("anti-thrash bounded fallback: suppresses intermediate turns, then re-fires when the window elapses", () => {
    // No session_compact success arrives (a silent compaction failure fires no event); the
    // pending flag must suppress re-triggers, then re-evaluate so the feature retries rather
    // than deadlocking.
    let state: ProactivePendingState = decideProactiveCompaction(usageAt(90), 85, fresh()).pending;
    // Intermediate turns while pending never compact (pins the anti-thrash bound).
    for (let turn = 1; turn < PROACTIVE_PENDING_MAX_TURNS; turn++) {
      const d = decideProactiveCompaction(usageAt(90), 85, state);
      expect(d.compact).toBe(false);
      state = d.pending;
    }
    // On the turn the fallback window elapses it re-fires in that same turn.
    expect(decideProactiveCompaction(usageAt(90), 85, state).compact).toBe(true);
  });

  it("cooldown after a completed compaction: suppresses for the cooldown window, then re-fires", () => {
    // pendingStateAfterCompaction() is what the handler adopts on `session_compact` success.
    let state: ProactivePendingState = pendingStateAfterCompaction();
    for (let turn = 0; turn < PROACTIVE_COOLDOWN_TURNS; turn++) {
      const d = decideProactiveCompaction(usageAt(90), 85, state);
      expect(d.compact, `cooldown turn ${turn} must not compact`).toBe(false);
      state = d.pending;
    }
    // Once the cooldown elapses, an at/over-threshold turn compacts again.
    expect(decideProactiveCompaction(usageAt(90), 85, state).compact).toBe(true);
  });
});

describe("proactive compaction (offline integration via fake-pi)", () => {
  let dir: string;
  let pi: FakePi;
  const originalCwd = process.cwd();
  const savedUserDir = process.env.PICC_CLAUDE_USER_DIR;

  // Drive the state machine back to a clean baseline (no pending request, no cooldown, no
  // in-flight marker) regardless of what a prior test left behind: enough below-threshold
  // turns to age out both the pending fallback and the post-compaction cooldown.
  const drainProactiveState = async () => {
    const low = pi.ctx({ getContextUsage: () => ({ tokens: 10, contextWindow: 1000, percent: 1 }) });
    for (let i = 0; i < PROACTIVE_PENDING_MAX_TURNS + PROACTIVE_COOLDOWN_TURNS + 1; i++) {
      await pi.fire("agent_settled", {}, low);
    }
  };

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "picc-proactive-"));
    fs.mkdirSync(path.join(dir, ".claude"), { recursive: true });
    fs.writeFileSync(path.join(dir, "CLAUDE.md"), "# Test project\n");
    // A PreCompact hook keyed on the trigger (manual|auto): each matcher appends its own
    // trigger to a marker so a test can read back which trigger PiCC presented.
    fs.writeFileSync(
      path.join(dir, ".claude", "settings.json"),
      JSON.stringify({
        hooks: {
          PreCompact: [
            {
              matcher: "auto",
              hooks: [
                { type: "command", command: 'echo auto >> "$CLAUDE_PROJECT_DIR/.claude/.precompact-log"' },
              ],
            },
            {
              matcher: "manual",
              hooks: [
                { type: "command", command: 'echo manual >> "$CLAUDE_PROJECT_DIR/.claude/.precompact-log"' },
              ],
            },
          ],
        },
      }),
    );
    const userDir = path.join(dir, ".claude-user");
    fs.mkdirSync(userDir, { recursive: true });
    process.env.PICC_CLAUDE_USER_DIR = userDir;
    process.chdir(dir);
    pi = fakePi();
    picc(pi.api as never, { onInitializationSettled: pi.captureInitialization });
    await pi.waitForInitialization();
    await pi.waitForTools(["bash", "read", "write", "edit", "grep", "find", "ls"]);
  });

  afterAll(() => {
    process.chdir(originalCwd);
    if (savedUserDir === undefined) delete process.env.PICC_CLAUDE_USER_DIR;
    else process.env.PICC_CLAUDE_USER_DIR = savedUserDir;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("compacts once and emits an always-visible notice when above threshold", async () => {
    await drainProactiveState();
    pi.compactCalls.length = 0;
    pi.notifications.length = 0;
    pi.entries.length = 0;
    const ctx = pi.ctx({ getContextUsage: () => ({ tokens: 900, contextWindow: 1000, percent: 90 }) });

    await pi.fire("agent_settled", {}, ctx);
    expect(pi.compactCalls.length).toBe(1);

    const notice = pi.notifications.find((n) => n.text.includes("proactiveCompactPercent"));
    expect(notice, "expected an always-visible proactive-compaction notice").toBeDefined();
    expect(notice!.text).toContain("compacting");
    expect(notice!.severity).toBe("info");
    // Headless fallback: a persisted entry leaves a trace even when ui.notify no-ops.
    const entry = pi.entries.find((e) => e.customType === "picc-proactive-compact");
    expect(entry, "expected a persisted proactive-compaction entry").toBeDefined();
    expect(String(entry!.data.notice)).toContain("proactiveCompactPercent");

    // Anti-thrash: a second above-threshold turn does not compact again.
    await pi.fire("agent_settled", {}, ctx);
    expect(pi.compactCalls.length).toBe(1);

    // A success event opens the cooldown window: the next PROACTIVE_COOLDOWN_TURNS
    // above-threshold turns do NOT re-compact (anti-thrash when usage stays high).
    await pi.fire("session_compact", {}, ctx);
    for (let i = 0; i < PROACTIVE_COOLDOWN_TURNS; i++) {
      await pi.fire("agent_settled", {}, ctx);
      expect(pi.compactCalls.length, `cooldown turn ${i} must not re-compact`).toBe(1);
    }
    // Once the cooldown elapses, the next above-threshold turn compacts again.
    await pi.fire("agent_settled", {}, ctx);
    expect(pi.compactCalls.length).toBe(2);
  });

  it("presents a proactive compaction to PreCompact as trigger:auto, while a user /compact stays manual", async () => {
    await drainProactiveState();
    const marker = path.join(dir, ".claude", ".precompact-log");
    fs.rmSync(marker, { force: true });
    pi.compactCalls.length = 0;
    const ctx = pi.ctx({ getContextUsage: () => ({ tokens: 900, contextWindow: 1000, percent: 90 }) });

    // A proactive compaction marks the in-flight request and calls ctx.compact().
    await pi.fire("agent_settled", {}, ctx);
    expect(pi.compactCalls.length).toBe(1);
    // Pi reports its programmatic compaction to this event as reason:"manual"; PiCC must
    // present it to PreCompact hooks as trigger:"auto" (Claude fidelity).
    await pi.fire("session_before_compact", { reason: "manual" }, ctx);
    expect(fs.readFileSync(marker, "utf8").trim().split(/\r?\n/)).toEqual(["auto"]);

    // A genuine user /compact (no in-flight marker) stays manual.
    await pi.fire("session_before_compact", { reason: "manual" }, ctx);
    expect(fs.readFileSync(marker, "utf8").trim().split(/\r?\n/)).toEqual(["auto", "manual"]);
  });

  it("re-fires through the handler after the pending fallback expires with no session_compact", async () => {
    await drainProactiveState();
    pi.compactCalls.length = 0;
    const ctx = pi.ctx({ getContextUsage: () => ({ tokens: 900, contextWindow: 1000, percent: 90 }) });

    await pi.fire("agent_settled", {}, ctx);
    expect(pi.compactCalls.length).toBe(1);

    // No session_compact success arrives (a silent compaction failure fires no event); after
    // the bounded fallback elapses the request is treated as failed and re-fires.
    for (let i = 0; i < PROACTIVE_PENDING_MAX_TURNS; i++) {
      await pi.fire("agent_settled", {}, ctx);
    }
    expect(pi.compactCalls.length).toBe(2);
  });

  it("does not compact and emits no notice on a below-threshold turn", async () => {
    await drainProactiveState();
    pi.compactCalls.length = 0;
    pi.notifications.length = 0;
    const ctx = pi.ctx({ getContextUsage: () => ({ tokens: 100, contextWindow: 1000, percent: 10 }) });
    await pi.fire("agent_settled", {}, ctx);
    expect(pi.compactCalls.length).toBe(0);
    expect(pi.notifications.find((n) => n.text.includes("proactiveCompactPercent"))).toBeUndefined();
  });

  it("does not throw or compact when getContextUsage returns the partial legacy shape", async () => {
    await drainProactiveState();
    pi.compactCalls.length = 0;
    const ctx = pi.ctx({ getContextUsage: () => ({ tokens: 1234 }) });
    await pi.fire("agent_settled", {}, ctx);
    expect(pi.compactCalls.length).toBe(0);
  });

  it("does not throw or compact when getContextUsage itself throws", async () => {
    await drainProactiveState();
    pi.compactCalls.length = 0;
    const ctx = pi.ctx({
      getContextUsage: () => {
        throw new Error("boom");
      },
    });
    await pi.fire("agent_settled", {}, ctx);
    expect(pi.compactCalls.length).toBe(0);
  });
});

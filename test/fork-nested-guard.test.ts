import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import picc from "../src/index.js";
import type { PiSdk, PiSessionMessage } from "../src/runtime/subagents.js";
import { fakePi, type FakePi } from "./helpers/fake-pi.js";
import {
  fakeSdk,
  type FakeCustomTool,
  type FakeSdkHandle,
  type FakeSdkOptions,
  type FakeSessionState,
} from "./helpers/fake-sdk.js";
import { cleanupFixture, materializeFixture } from "./helpers/fixture.js";

/**
 * F16 t02 — fork-spawns-fork guard (runtime-set `dispatcherIsFork` marker).
 *
 * The nested Agent/Task tool with the marker threading exists ONLY through the
 * real `picc()` wiring (customToolsFor → createAgentToolDefinition → dispatchOpts),
 * so this is an offline-integration test (real `picc()` + injected fake SDK),
 * following `test/slashcommand-fork.test.ts`. To prove the marker path — not a
 * vacuous degrade — each scenario GUARANTEES a genuine top-level fork first: the
 * fixture provides a main-session transcript (via session_start), the fake
 * `forkSessionManager` returns a usable seeded stub, and the top dispatch runs at
 * depth 1. Only then is that fork's granted Agent tool driven to make the nested
 * dispatch under test.
 */

const FORK_ENV = "CLAUDE_CODE_FORK_SUBAGENT";
const FORK_DEGRADE = "fork ran with fresh context:";
const CANNOT_SPAWN = "a fork cannot spawn another fork";
const NESTED_WORDING = "nested fork";
const PARENT_TOKEN = "PARENT-SECRET-TOKEN-t02";
const SEED: PiSessionMessage[] = [
  { role: "user", content: `earlier the user said: ${PARENT_TOKEN}` },
  { role: "assistant", content: [{ type: "text", text: "ack" }], stopReason: "stop" },
];

let dir: string;
let mainFile: string;
const originalCwd = process.cwd();

beforeAll(() => {
  dir = materializeFixture("full-surface");
  const userDir = path.join(dir, ".claude-user");
  fs.mkdirSync(userDir, { recursive: true });
  process.env.PICC_CLAUDE_USER_DIR = userDir;
  process.chdir(dir);
  // A plausible main-session transcript path — the FAKE fork manager never reads
  // it (subagentSessionDir is pure path derivation), so it need not exist.
  mainFile = path.join(dir, "main-session.jsonl");
});

afterAll(() => {
  process.chdir(originalCwd);
  delete process.env.PICC_CLAUDE_USER_DIR;
  cleanupFixture(dir);
});

// Save/restore the gate env around each test (matching runtime-core.test.ts) so a
// test that sets it can never leak the value into a sibling test or the harness.
let prevForkEnv: string | undefined;
beforeEach(() => {
  prevForkEnv = process.env[FORK_ENV];
});
afterEach(() => {
  if (prevForkEnv === undefined) delete process.env[FORK_ENV];
  else process.env[FORK_ENV] = prevForkEnv;
});

interface AgentResult {
  content: Array<{ type: string; text: string }>;
  details: Record<string, unknown>;
}

interface Wired {
  pi: FakePi;
  h: FakeSdkHandle;
  agentTool: {
    execute: (id: string, params: Record<string, unknown>) => Promise<AgentResult>;
  };
  nested: { result?: AgentResult; result2?: AgentResult };
}

/**
 * Wire a REAL `picc()` around a fake SDK, seed a genuine main-session transcript
 * (session_start → getMainSessionFile), and expose the coordinator's Agent tool.
 * `nestedAction` is invoked from inside the FIRST dispatched session that has a
 * granted Agent tool (the top-level fork's session) — its result is captured on
 * `nested.result`. `nestedAction2` (optional) is invoked from the SECOND
 * Agent-bearing session (e.g. the top fork's normal child), captured on
 * `nested.result2` — used by the scoping test to drive a grandchild dispatch.
 */
async function wireFork(opts: {
  sdkOptions?: FakeSdkOptions;
  transformSdk?: (sdk: PiSdk) => PiSdk;
  nestedAction?: (agent: FakeCustomTool) => Promise<AgentResult>;
  nestedAction2?: (agent: FakeCustomTool) => Promise<AgentResult>;
}): Promise<Wired> {
  const nested: { result?: AgentResult; result2?: AgentResult } = {};
  let agentSessions = 0;
  const h = fakeSdk({
    forkSeed: SEED,
    ...opts.sdkOptions,
    onPrompt: async (_text: string, session: FakeSessionState) => {
      const agent = session.customTools.find((t: FakeCustomTool) => t.name === "Agent");
      if (agent) {
        agentSessions += 1;
        if (agentSessions === 1 && opts.nestedAction) {
          nested.result = await opts.nestedAction(agent);
        } else if (agentSessions === 2 && opts.nestedAction2) {
          nested.result2 = await opts.nestedAction2(agent);
        }
      }
      return "TOP-FORK-REPLY";
    },
  });
  const sdk = opts.transformSdk ? opts.transformSdk(h.sdk) : h.sdk;
  const pi = fakePi();
  picc(pi.api as never, { sdk });
  // getMainSessionFile() must return a real path so a depth-1 fork can inherit —
  // it is populated from ctx.sessionManager captured on session_start.
  await pi.fire(
    "session_start",
    { reason: "startup" },
    pi.ctx({ sessionManager: { getSessionFile: () => mainFile, getEntries: () => [] } }),
  );
  const agentTool = pi.tools.get("Agent") as Wired["agentTool"];
  return { pi, h, agentTool, nested };
}

function diagMessages(result: AgentResult): string[] {
  return ((result.details.diagnostics as Array<{ message: string }>) ?? []).map((d) => d.message);
}

/**
 * Temporarily raise the fixture's `subagents.maxDepth` (default 2) so a THREE-level
 * chain (fork → normal child → grandchild) can be exercised. Returns the previous
 * value so the caller can restore it — the fixture dir is shared across this file's
 * tests, and picc() reads maxDepth once at construction.
 */
function setFixtureMaxDepth(n: number): number {
  const p = path.join(dir, ".claude", "settings.json");
  const settings = JSON.parse(fs.readFileSync(p, "utf8")) as {
    subagents: { maxDepth: number };
  };
  const prev = settings.subagents.maxDepth;
  settings.subagents.maxDepth = n;
  fs.writeFileSync(p, JSON.stringify(settings, null, 2));
  return prev;
}

describe("F16 t02 — a fork cannot spawn another fork (runtime-set marker)", () => {
  it("refuses a fork's nested `subagent_type: fork` with the DISTINCT cannot-spawn notice, via the marker (not the depth guard)", async () => {
    // env unset ⇒ inheritance enabled (PiCC default).
    const { h, agentTool, nested } = await wireFork({
      nestedAction: (agent) =>
        agent.execute("nested", {
          subagent_type: "fork",
          prompt: "the nested fork task",
          run_in_background: false,
        }),
    });

    const top = await agentTool.execute("top", {
      subagent_type: "fork",
      prompt: "the top task",
      run_in_background: false,
    });

    // GUARD against a vacuous pass: the TOP fork must be a GENUINE inheriting fork
    // (Agent(fork) badge, no degrade footer, the child seeded with parent history),
    // otherwise `dispatcherIsFork` is never set and the nested refusal proves nothing.
    expect(top.details.agent).toBe("fork");
    expect(diagMessages(top).some((m) => m.startsWith(FORK_DEGRADE))).toBe(false);
    expect(h.sessions[0]!.inheritedMessageCount).toBe(SEED.length);
    expect(JSON.stringify(h.sessions[0]!.messages)).toContain(PARENT_TOKEN);

    // The NESTED fork was refused: degraded to a fresh general-purpose identity…
    const inner = nested.result!;
    expect(inner.details.agent).toBe("general-purpose");
    // …with the DISTINCT fork-specific "cannot spawn a fork" notice (proving the
    // MARKER path, not the generic gate/nested degrade), and NOT the nested/gate
    // wording.
    const innerMsgs = diagMessages(inner);
    const degrade = innerMsgs.find((m) => m.startsWith(FORK_DEGRADE))!;
    expect(degrade).toContain(CANNOT_SPAWN);
    expect(degrade).not.toContain(NESTED_WORDING);
    expect(degrade).not.toContain(FORK_ENV);
    // Toned CALM (info): fork-spawns-fork is a by-design refusal, not a can't-do.
    const innerDiag = (
      inner.details.diagnostics as Array<{ message: string; severity: string }>
    ).find((d) => d.message.startsWith(FORK_DEGRADE))!;
    expect(innerDiag.severity).toBe("info");
    // The nested fork NEVER inherited: no seeded history, and forkSessionManager was
    // called EXACTLY ONCE (the top fork) — the refusal short-circuits before forkFrom.
    expect(h.sessions[1]!.inheritedMessageCount).toBe(0);
    expect(h.forkCalls()).toHaveLength(1);
  });

  it("still lets a genuine fork spawn a NORMAL subagent type (subject to the depth cap)", async () => {
    const { h, agentTool, nested } = await wireFork({
      nestedAction: (agent) =>
        agent.execute("nested", {
          subagent_type: "general-purpose",
          prompt: "a normal side task",
          run_in_background: false,
        }),
    });

    const top = await agentTool.execute("top", {
      subagent_type: "fork",
      prompt: "the top task",
      run_in_background: false,
    });
    // Genuine top-level fork (same guard as above).
    expect(top.details.agent).toBe("fork");
    expect(h.sessions[0]!.inheritedMessageCount).toBe(SEED.length);

    // The NORMAL nested dispatch is NOT refused: it completes as general-purpose
    // with NO fork-degrade notice (a normal type never enters the fork branch).
    const inner = nested.result!;
    expect(inner.details.outcome).toBe("completed");
    expect(inner.details.agent).toBe("general-purpose");
    expect(diagMessages(inner).some((m) => m.startsWith(FORK_DEGRADE))).toBe(false);
    // Only the top fork forked; the normal spawn never touches forkSessionManager.
    expect(h.forkCalls()).toHaveLength(1);
  });

  it("a forkFrom-throw degrade yields isFork=false, UNMARKED tools, and the honest general-purpose badge", async () => {
    // The top-level "fork" degrades because forkSessionManager THROWS. The trap fix
    // resolves this to a plain general-purpose (isFork=false, unmarked tools,
    // Agent(general-purpose) badge) BEFORE the identity/tools are finalized.
    const { h, agentTool, nested } = await wireFork({
      transformSdk: (sdk) => ({
        ...sdk,
        forkSessionManager: () => {
          throw new Error(`fork boom at ${mainFile} (simulated)`);
        },
      }),
      // The degraded top runs as general-purpose (depth 1) and still gets an Agent
      // tool — drive a nested "fork" through it to prove its tools are UNMARKED.
      nestedAction: (agent) =>
        agent.execute("nested", {
          subagent_type: "fork",
          prompt: "nested from a degraded parent",
          run_in_background: false,
        }),
    });

    const top = await agentTool.execute("top", {
      subagent_type: "fork",
      prompt: "the top task",
      run_in_background: false,
    });

    // Honest badge: the throw degrades to general-purpose (NOT a stale Agent(fork)),
    // with the forkFrom-throw notice.
    expect(top.details.agent).toBe("general-purpose");
    const topMsgs = diagMessages(top);
    expect(topMsgs.some((m) => m.startsWith(FORK_DEGRADE))).toBe(true);
    expect(topMsgs.some((m) => m.includes("forking the parent session failed"))).toBe(true);
    expect(h.sessions[0]!.inheritedMessageCount).toBe(0);

    // Its tools are UNMARKED: the nested "fork" is NOT mis-refused as fork-spawns-
    // fork — it degrades via the ordinary NESTED reason (depth ≠ 1), proving the
    // degraded parent never set `dispatcherIsFork`.
    const inner = nested.result!;
    const innerDegrade = diagMessages(inner).find((m) => m.startsWith(FORK_DEGRADE))!;
    expect(innerDegrade).toContain(NESTED_WORDING);
    expect(innerDegrade).not.toContain(CANNOT_SPAWN);
  });

  it("a NON-fork dispatcher (the coordinator) can still fork — the marker is scoped, not global", async () => {
    // Sanity: the coordinator is not a fork, so its own `subagent_type: fork`
    // dispatch is honored (proves `dispatcherIsFork` is per-dispatch, never set for
    // ordinary dispatchers).
    const { h, agentTool } = await wireFork({});
    const top = await agentTool.execute("top", {
      subagent_type: "fork",
      prompt: "the top task",
      run_in_background: false,
    });
    expect(top.details.agent).toBe("fork");
    expect(diagMessages(top).some((m) => m.startsWith(FORK_DEGRADE))).toBe(false);
    expect(h.sessions[0]!.inheritedMessageCount).toBe(SEED.length);
  });

  it("the marker does NOT leak past the per-dispatch boundary: a fork's NORMAL child's own nested `fork` degrades via the DEPTH/nested reason, not cannot-spawn", async () => {
    // Chain: genuine top-level fork (depth 1, inherits) → dispatches a NORMAL
    // general-purpose child (depth 2) → that child dispatches `subagent_type: fork`
    // (a grandchild, depth 3). If `dispatcherIsFork` leaked from the top fork onto
    // its normal child's Agent tool, the grandchild would be refused with the
    // MARKER wording ("cannot spawn a fork"). It must instead degrade via the
    // ordinary DEPTH/nested reason — proving the child's tools stayed UNMARKED
    // (the call site threads the RECOMPUTED `isFork`, not `opts.dispatcherIsFork`,
    // into `customToolsFor`).
    // A 3-level chain needs maxDepth ≥ 3 (fixture default is 2).
    const prevMaxDepth = setFixtureMaxDepth(3);
    try {
      const { h, agentTool, nested } = await wireFork({
        // First Agent-bearing session (the top fork): dispatch a NORMAL child.
        nestedAction: (agent) =>
          agent.execute("child", {
            subagent_type: "general-purpose",
            prompt: "a normal middle child",
            run_in_background: false,
          }),
        // Second Agent-bearing session (that normal child): dispatch a grandchild fork.
        nestedAction2: (agent) =>
          agent.execute("grandchild", {
            subagent_type: "fork",
            prompt: "a fork from the fork's NORMAL child",
            run_in_background: false,
          }),
      });

      const top = await agentTool.execute("top", {
        subagent_type: "fork",
        prompt: "the top task",
        run_in_background: false,
      });

      // Genuine top-level fork (non-vacuous guard).
      expect(top.details.agent).toBe("fork");
      expect(h.sessions[0]!.inheritedMessageCount).toBe(SEED.length);

      // The NORMAL middle child ran cleanly (no fork-degrade — a normal type never
      // enters the fork branch), even though its dispatcher (the top fork) was marked.
      const child = nested.result!;
      expect(child.details.agent).toBe("general-purpose");
      expect(child.details.outcome).toBe("completed");
      expect(diagMessages(child).some((m) => m.startsWith(FORK_DEGRADE))).toBe(false);

      // The GRANDCHILD fork degrades via the DEPTH/nested reason — NOT the marker
      // ("cannot spawn a fork") — proving the normal child's tools were unmarked.
      const grand = nested.result2!;
      expect(grand.details.agent).toBe("general-purpose");
      const grandDegrade = diagMessages(grand).find((m) => m.startsWith(FORK_DEGRADE))!;
      expect(grandDegrade).toContain(NESTED_WORDING);
      expect(grandDegrade).not.toContain(CANNOT_SPAWN);
      // Only the genuine top fork ever forked (children/grandchildren never inherit).
      expect(h.forkCalls()).toHaveLength(1);
    } finally {
      setFixtureMaxDepth(prevMaxDepth);
    }
  });

  it("a fork dispatch ABORTED before start leaves NO on-disk fork transcript (forkFrom never runs)", async () => {
    // FIX 3 lock-in: `forkFrom` is eager + synchronous (it writes the full parent
    // conversation to disk the instant it is called). Its construction is DEFERRED
    // to after the abort-before-start / SubagentStart-block / abort-after-worktree
    // gates, so a dispatch aborted before it starts must never touch the fork
    // machinery. Offline the fake forkSessionManager does not write a real file,
    // so `forkCalls()` staying EMPTY is the load-bearing regression signal (before
    // the relocation, forkFrom ran at interception — before the abort gate — and
    // would have been called + written a file); the subagents-dir check locks in
    // the on-disk consequence.
    const subDir = path.join(dir, "main-session.subagents");
    const existedBefore = fs.existsSync(subDir);

    const { h, agentTool } = await wireFork({});
    const aborted = AbortSignal.abort();

    // A fork dispatch aborted before start surfaces on the isError channel.
    await expect(
      (
        agentTool.execute as unknown as (
          id: string,
          params: Record<string, unknown>,
          signal: AbortSignal,
        ) => Promise<AgentResult>
      )(
        "top",
        { subagent_type: "fork", prompt: "aborted before start", run_in_background: false },
        aborted,
      ),
    ).rejects.toThrow(/stopped before it started/);

    // forkFrom was never invoked — the deferred construction sits after the gates.
    expect(h.forkCalls()).toHaveLength(0);
    // No fork transcript was written: the subagents dir was not created by this run.
    if (!existedBefore) {
      expect(fs.existsSync(subDir)).toBe(false);
    } else {
      expect(fs.readdirSync(subDir)).toHaveLength(0);
    }
  });
});

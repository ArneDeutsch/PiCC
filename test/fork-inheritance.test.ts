import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createAgentToolDefinition,
  type PiSessionMessage,
} from "../src/runtime/subagents.js";
import {
  BackgroundTaskRegistry,
  createTaskOutputTool,
} from "../src/runtime/background-tasks.js";
import {
  RECORD_EXPAND_HINT,
  RECORD_FORK_MARKER,
  renderAgentResult,
} from "../src/runtime/subagent-render.js";
import { FORK_DEGRADE_PREFIX, subagentSessionDir } from "../src/util/subagent-transcripts.js";
import {
  fakeSdk,
  makeSubagentRuntime,
  type FakeHookRunner,
  type SubagentRuntimeOverrides,
} from "./helpers/fake-sdk.js";
import type { HookOutcome } from "../src/types.js";

/**
 * `subagent_type: "fork"` parent-conversation inheritance, env gate,
 * and VISIBLE degrade. These are the unit/wiring layer; the genuine on-disk
 * forkFrom proof (real Pi SessionManager) lives in subagent-transcripts.test.ts.
 */

const FORK_ENV = "CLAUDE_CODE_FORK_SUBAGENT";
// A plausible main-session transcript path — the FAKE fork manager never reads
// it (subagentSessionDir is pure path derivation), so it need not exist.
const MAIN = "C:\\pi\\sessions\\proj\\2026-01-01T00-00-00-000Z_main.jsonl";
const PARENT_TOKEN = "PARENT-SECRET-TOKEN-9x7";
const SEED: PiSessionMessage[] = [
  { role: "user", content: `earlier the user said: ${PARENT_TOKEN}` },
  { role: "assistant", content: [{ type: "text", text: "ack" }], stopReason: "stop" },
];

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

function forkRuntime(
  opts: {
    replies?: string[];
    forkSeed?: PiSessionMessage[];
    noForkSessionManager?: boolean;
    withMainFile?: boolean;
    overrides?: SubagentRuntimeOverrides;
  } = {},
) {
  const h = fakeSdk({
    replies: opts.replies ?? ["fork-final-answer"],
    forkSeed: opts.forkSeed ?? SEED,
    noForkSessionManager: opts.noForkSessionManager,
  });
  const overrides: SubagentRuntimeOverrides = {
    ...(opts.withMainFile === false ? {} : { getMainSessionFile: () => MAIN }),
    ...opts.overrides,
  };
  const runtime = makeSubagentRuntime([], h.sdk, overrides);
  return { h, runtime };
}

describe("fork dispatch — genuine inheritance (fake wiring)", () => {
  it("a main-session (depth 1) fork forks the main transcript and inherits its history", async () => {
    const { h, runtime } = forkRuntime();
    const result = await runtime.dispatch({ subagentType: "fork", prompt: "continue", depth: 1 });

    expect(result.ok).toBe(true);
    expect(result.isFork).toBe(true);
    // forkSessionManager called with (mainFile, cwd, subagentSessionDir(main), agentId).
    const calls = h.forkCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.sourcePath).toBe(MAIN);
    expect(calls[0]!.sessionDir).toBe(subagentSessionDir(MAIN));
    expect(calls[0]!.id).toBe(result.agentId);
    // The child session inherited the seed (fresh vs fork is a one-line diff).
    expect(h.sessions[0]!.inheritedMessageCount).toBe(SEED.length);
    expect(JSON.stringify(h.sessions[0]!.messages)).toContain(PARENT_TOKEN);
    // Badge reads as a fork; the verbatim final message is the fork's own reply.
    expect(result.agentName).toBe("fork");
    expect(result.finalMessage).toBe("fork-final-answer");
  });

  it("a fork is NEVER resumable — in the returned result AND the persisted posture", async () => {
    const { runtime } = forkRuntime();
    const result = await runtime.dispatch({ subagentType: "fork", prompt: "p", depth: 1 });
    // Persisted transcript posture (a real child file), but forced non-resumable.
    expect(result.transcriptPath).toBeDefined();
    expect(result.resumable).toBe(false);
  });

  it("output isolation: only the fork's final reply returns; the inherited seed is not surfaced", async () => {
    const { runtime } = forkRuntime({ replies: ["THE-VERBATIM-RESULT"] });
    const result = await runtime.dispatch({ subagentType: "fork", prompt: "p", depth: 1 });
    expect(result.finalMessage).toBe("THE-VERBATIM-RESULT");
    expect(result.finalMessage).not.toContain(PARENT_TOKEN);
  });

  it("uses the parent tools + inherited model + a neutral same-context system prompt (not a fork:<skill> override)", async () => {
    const specs: Array<string | undefined> = [];
    const { h, runtime } = forkRuntime({
      overrides: {
        resolveModel: (spec) => {
          specs.push(spec);
          return spec === undefined ? { inherited: true } : { spec };
        },
      },
    });
    await runtime.dispatch({ subagentType: "fork", prompt: "p", depth: 1 });
    // All-tools grant (main-session grant), NOT a narrowed agent persona.
    const tools = h.created[0]!.tools as string[];
    for (const t of ["read", "write", "edit", "bash"]) expect(tools).toContain(t);
    // Model INHERITED (resolveModel(undefined)) — no fork-specific model spec.
    expect(specs).toContain(undefined);
    // System prompt is the neutral reconstruction for agent name "fork" — never a
    // `fork:<skill>` override string (that is the unrelated skill context:fork).
    const loader = h.created[0]!.resourceLoader as {
      options: { systemPromptOverride: () => string };
    };
    expect(loader.options.systemPromptOverride()).toBe("SYSTEM:fork");
    expect(loader.options.systemPromptOverride()).not.toContain("fork:");
  });

  it("unset CLAUDE_CODE_FORK_SUBAGENT defaults to ENABLED (inheritance occurs, no degrade notice)", async () => {
    delete process.env[FORK_ENV];
    const { h, runtime } = forkRuntime();
    const result = await runtime.dispatch({ subagentType: "fork", prompt: "p", depth: 1 });
    expect(result.isFork).toBe(true);
    expect(h.sessions[0]!.inheritedMessageCount).toBe(SEED.length);
    expect(result.diagnostics.some((d) => d.message.startsWith("fork ran with fresh context:"))).toBe(
      false,
    );
  });

  it("no parent history leaks into the SubagentStart hook payload (prompt = task text only)", async () => {
    const startPrompts: string[] = [];
    const hookRunner: FakeHookRunner = {
      fire: async (event: string, payload: Record<string, unknown>): Promise<HookOutcome> => {
        if (event === "SubagentStart") startPrompts.push(String(payload.prompt ?? ""));
        return { block: false, askDowngraded: false, diagnostics: [] };
      },
    };
    const { runtime } = forkRuntime({ overrides: { hookRunner } });
    await runtime.dispatch({ subagentType: "fork", prompt: "the fork task", depth: 1 });
    expect(startPrompts[0]).toBe("the fork task");
    expect(startPrompts[0]).not.toContain(PARENT_TOKEN);
  });
});

describe("fork dispatch — visible degrade (never the generic unknown-type warning)", () => {
  const GENERIC = 'unknown subagent_type "fork"; ran as general-purpose';

  function assertDegraded(result: Awaited<ReturnType<ReturnType<typeof forkRuntime>["runtime"]["dispatch"]>>, tone: "info" | "warning") {
    expect(result.ok).toBe(true);
    expect(result.isFork).toBeFalsy();
    // A fresh general-purpose identity — distinguishable from a fork in the badge.
    expect(result.agentName).toBe("general-purpose");
    // The specific fork notice, at the expected tone; NEVER the generic warning.
    const degrade = result.diagnostics.find((d) => d.message.startsWith("fork ran with fresh context:"));
    expect(degrade).toBeDefined();
    expect(degrade!.severity).toBe(tone);
    expect(result.diagnostics.some((d) => d.message.includes(GENERIC))).toBe(false);
  }

  it("CLAUDE_CODE_FORK_SUBAGENT=0 → fresh (no seeded messages) + calm (info) notice naming the fix", async () => {
    process.env[FORK_ENV] = "0";
    const { h, runtime } = forkRuntime();
    const result = await runtime.dispatch({ subagentType: "fork", prompt: "p", depth: 1 });
    assertDegraded(result, "info");
    expect(h.sessions[0]!.inheritedMessageCount).toBe(0);
    expect(h.forkCalls()).toHaveLength(0);
    const degrade = result.diagnostics.find((d) => d.message.startsWith("fork ran with fresh context:"))!;
    // The notice names the variable + the fix WITHOUT hardcoding `=0` (isEnvTruthy
    // treats 0/false/no/off/"" all as off, so the literal value must not be pinned).
    expect(degrade.message).toContain("CLAUDE_CODE_FORK_SUBAGENT");
    expect(degrade.message).not.toContain("CLAUDE_CODE_FORK_SUBAGENT=0");
    expect(degrade.message).toContain("unset it to enable");
  });

  it("no parent transcript (print/no-session) → fresh + warning notice", async () => {
    const { h, runtime } = forkRuntime({ withMainFile: false });
    const result = await runtime.dispatch({ subagentType: "fork", prompt: "p", depth: 1 });
    assertDegraded(result, "warning");
    expect(h.sessions[0]!.inheritedMessageCount).toBe(0);
    expect(h.forkCalls()).toHaveLength(0);
  });

  it("nested (depth > 1) dispatcher → fresh + warning notice; NEVER seeds from the main transcript", async () => {
    const { h, runtime } = forkRuntime();
    const result = await runtime.dispatch({ subagentType: "fork", prompt: "p", depth: 2 });
    assertDegraded(result, "warning");
    expect(h.sessions[0]!.inheritedMessageCount).toBe(0);
    expect(h.forkCalls()).toHaveLength(0);
    const degrade = result.diagnostics.find((d) => d.message.startsWith("fork ran with fresh context:"))!;
    expect(degrade.message).toContain("nested fork");
  });

  it("SDK lacks forkSessionManager → fresh + warning notice", async () => {
    const { h, runtime } = forkRuntime({ noForkSessionManager: true });
    const result = await runtime.dispatch({ subagentType: "fork", prompt: "p", depth: 1 });
    assertDegraded(result, "warning");
    expect(h.sessions[0]!.inheritedMessageCount).toBe(0);
  });

  it("forkFrom throws → fresh + warning notice (not a rejected dispatch)", async () => {
    const h = fakeSdk({ replies: ["survived the fork failure"], forkSeed: SEED });
    // Make forkSessionManager present but throwing.
    // SECURITY: the raw error embeds the main-session ABSOLUTE PATH — it must reach
    // the developer diagnostic (capped) but NEVER the model-facing prompt.
    const sdk = {
      ...h.sdk,
      forkSessionManager: () => {
        throw new Error(`fork boom at ${MAIN} (simulated)`);
      },
    };
    const runtime = makeSubagentRuntime([], sdk, { getMainSessionFile: () => MAIN });
    const result = await runtime.dispatch({ subagentType: "fork", prompt: "p", depth: 1 });
    expect(result.ok).toBe(true);
    expect(result.isFork).toBeFalsy();
    expect(result.finalMessage).toBe("survived the fork failure");
    expect(h.sessions[0]!.inheritedMessageCount).toBe(0);
    const degrade = result.diagnostics.find((d) => d.message.startsWith("fork ran with fresh context:"));
    expect(degrade?.severity).toBe("warning");
    expect(result.diagnostics.some((d) => d.message.includes('unknown subagent_type "fork"'))).toBe(
      false,
    );
    // The developer diagnostic keeps the capped error detail (incl. the path)…
    expect(degrade!.message).toContain("forking the parent session failed");
    expect(degrade!.message).toContain(MAIN);
    // …but the MODEL-facing prompt uses a GENERIC reason with NO raw error / path.
    const modelPrompt = h.sessions[0]!.messages.find((m) => m.role === "user")!.content as string;
    expect(modelPrompt).toContain("forking the parent session failed");
    expect(modelPrompt).not.toContain("fork boom");
    expect(modelPrompt).not.toContain(MAIN);
  });

  it("a project agent literally named `fork` does NOT shadow the reserved fork interception", async () => {
    // Even with a project agent named "fork", the interception wins: an honored
    // fork inherits (isFork true), never running the project agent fresh.
    const h = fakeSdk({ replies: ["ok"], forkSeed: SEED });
    const runtime = makeSubagentRuntime(
      [
        {
          name: "fork",
          description: "a project agent that happens to be named fork",
          body: "PROJECT FORK BODY",
          metadata: {},
          source: { path: "<test>", scope: "project" },
          unknownKeys: [],
          diagnostics: [],
        },
      ],
      h.sdk,
      { getMainSessionFile: () => MAIN },
    );
    const result = await runtime.dispatch({ subagentType: "fork", prompt: "p", depth: 1 });
    expect(result.isFork).toBe(true);
    expect(h.sessions[0]!.inheritedMessageCount).toBe(SEED.length);
  });
});

describe("fork dispatch — developer-facing rendering (renderAgentResult)", () => {
  function renderLines(
    details: Record<string, unknown>,
    expanded: boolean,
    text = "answer",
    width = 120,
  ): string[] {
    const comp = renderAgentResult(
      { content: [{ type: "text", text }], details },
      { expanded, isPartial: false },
      undefined,
    );
    return comp.render(width);
  }
  const degraded = {
    outcome: "completed",
    agent: "general-purpose",
    diagnostics: [
      {
        severity: "info",
        message:
          "fork ran with fresh context: fork inheritance is disabled via CLAUDE_CODE_FORK_SUBAGENT; unset it to enable",
      },
    ],
  };

  it("a successful fork uses concise lifecycle grammar with no degrade marker, collapsed or expanded", () => {
    const clean = { outcome: "completed", agent: "fork", diagnostics: [] };
    const collapsed = renderLines(clean, false).join("\n");
    expect(collapsed).toContain("fork [completed]");
    expect(collapsed).not.toContain(RECORD_FORK_MARKER);
    const expanded = renderLines(clean, true).join("\n");
    expect(expanded).toContain("fork [completed]");
    expect(expanded).not.toContain("fork ran with fresh context");
  });

  it("a degraded fork's COLLAPSED record carries the ⚠ marker — the warning is never expand-only", () => {
    const lines = renderLines(degraded, false);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("general-purpose [completed]");
    expect(lines[0]).not.toContain("fork [");
    expect(lines[0]).toContain(RECORD_FORK_MARKER);
  });

  it("a degraded fork EXPANDED badges as the fresh agent AND shows the full fork-degrade footer line", () => {
    const joined = renderLines(degraded, true).join("\n");
    expect(joined).toContain("general-purpose [completed]");
    expect(joined).not.toContain("fork [");
    expect(joined).toContain("fork ran with fresh context: fork inheritance is disabled");
  });

  it("keeps one fork warning and expansion cue on practical collapsed success/failure rows", () => {
    for (const width of [72, 96]) {
      for (const outcome of ["completed", "failed"] as const) {
        const joined = renderLines({ ...degraded, outcome }, false, "answer", width).join("\n");
        expect(joined.split(RECORD_FORK_MARKER)).toHaveLength(2);
        expect(joined.split(RECORD_EXPAND_HINT)).toHaveLength(2);
        expect(joined).toContain(`general-purpose [${outcome}]`);
      }
    }
  });
});

describe("fork dispatch reaches the developer-facing footer through the Agent tool", () => {
  it("a degraded fork's Agent-tool result carries the fork diagnostic in details.diagnostics", async () => {
    process.env[FORK_ENV] = "0";
    const { runtime } = forkRuntime();
    const tool = createAgentToolDefinition(runtime, { depth: 0 }) as unknown as {
      execute: (
        id: string,
        params: Record<string, unknown>,
        signal?: AbortSignal,
      ) => Promise<{ content: Array<{ text: string }>; details: Record<string, unknown> }>;
    };
    // run_in_background:false → foreground so the result returns inline (no
    // background registry wired here anyway).
    const res = await tool.execute("t", {
      subagent_type: "fork",
      prompt: "p",
      run_in_background: false,
    });
    const diagnostics = res.details.diagnostics as Array<{ message: string }>;
    expect(diagnostics.some((d) => d.message.startsWith(FORK_DEGRADE_PREFIX))).toBe(true);
    expect(res.details.agent).toBe("general-purpose");
  });
});

describe("fork dispatch reaches the developer-facing footer through the BACKGROUND (TaskOutput) surface", () => {
  it("a degraded fork dispatched with run_in_background:true carries the fork diagnostic on the settled TaskOutput result", async () => {
    // Acceptance: the degrade footer must reach BOTH the synchronous AND the
    // backgrounded/TaskOutput surface. Dispatch a degrading fork (env=0) in the
    // background, wait for settlement, then read the SETTLED TaskOutput result and
    // assert its details.diagnostics carries the fork-specific message — the same
    // channel the renderer's muted footer reads (background-tasks copies the
    // dispatch diagnostics onto the task record → TaskOutput details).
    process.env[FORK_ENV] = "0";
    const { runtime } = forkRuntime();
    const registry = new BackgroundTaskRegistry();
    const tool = createAgentToolDefinition(runtime, {
      depth: 0,
      backgroundTasks: registry,
    }) as unknown as {
      execute: (
        id: string,
        params: Record<string, unknown>,
      ) => Promise<{ content: Array<{ text: string }>; details: Record<string, unknown> }>;
    };
    const started = await tool.execute("t", {
      subagent_type: "fork",
      prompt: "p",
      run_in_background: true,
    });
    const taskId = String(started.details.taskId);
    await registry.wait(taskId);
    const out = await (
      createTaskOutputTool(registry) as unknown as {
        execute: (
          id: string,
          params: Record<string, unknown>,
        ) => Promise<{ content: Array<{ text: string }>; details: Record<string, unknown> }>;
      }
    ).execute("t2", { task_id: taskId });
    // The fork-degrade diagnostic reached the BACKGROUND surface (the renderer's
    // muted footer reads this same `details.diagnostics` channel). NOTE: the
    // background badge label (`details.agent`) is the eagerly-captured requested
    // TYPE ("fork") by design, not the final resolved agent — so only the footer
    // channel is asserted here, matching the acceptance criterion.
    const diagnostics = out.details.diagnostics as Array<{ message: string }>;
    expect(diagnostics.some((d) => d.message.startsWith(FORK_DEGRADE_PREFIX))).toBe(true);
  });
});

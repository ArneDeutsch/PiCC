import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
  allText,
  BASH_AVAILABLE,
  CHECKPOINT_CONTEXT_WINDOW,
  CHECKPOINT_PI_SETTINGS,
  CHECKPOINT_USAGE,
  cliMissing,
  createE2ELive,
  findSessionFiles,
  readJsonLines,
  REPO_ROOT,
  systemText,
  toolResultText,
  TEST_TIMEOUT_MS,
  toolNames,
  userText,
  writeCheckpointConfig,
  CLI_PATH,
} from "./helpers/e2e-live.js";
import { createResponseGate } from "./helpers/mock-openai.js";

/**
 * E2E — core wiring: full Claude project context assembled into the real
 * model request, and a /deploy slash-skill expanded through Pi's input event.
 * See test/helpers/e2e-live.ts for the shared runPi harness.
 */

const { startPi, runPi, cleanup } = createE2ELive();
afterEach(cleanup);

const TOOL_ROW_PRESENTATION = /[○●✗■]|\u001b\[[0-?]*[ -/]*[@-~]/u;

function expectNoToolRowPresentation(value: unknown, source: string): void {
  if (typeof value === "string") {
    expect(value, source).not.toMatch(TOOL_ROW_PRESENTATION);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => expectNoToolRowPresentation(entry, `${source}[${index}]`));
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      expectNoToolRowPresentation(entry, `${source}.${key}`);
    }
  }
}

function expectCanonicalWriteResult(
  records: any[],
  expectedText: string,
): void {
  const writeResults = records.filter((record) => record.type === "message_end" &&
    record.message?.role === "toolResult" && record.message?.toolName === "write");
  expect(writeResults).toHaveLength(1);
  const message = writeResults[0].message;
  const keys = ["content", "isError", "role", "timestamp", "toolCallId", "toolName"];
  if (message.terminate !== undefined) keys.push("terminate");
  expect(Object.keys(message).sort()).toEqual(keys.sort());
  expect(message).toEqual({
    role: "toolResult",
    toolCallId: expect.any(String),
    toolName: "write",
    content: [{ type: "text", text: expectedText }],
    isError: false,
    timestamp: expect.any(Number),
    ...(message.terminate === undefined ? {} : { terminate: true }),
  });
}

it.skipIf(cliMissing || !BASH_AVAILABLE)(
  "e2e core: real Pi RPC bash traverses PiCC user_bash once per command",
  async () => {
    const childScript = [
      'const fs=require("node:fs")',
      'fs.appendFileSync("rpc-bash-marker.json",JSON.stringify({skip:process.env.PI_SKIP_VERSION_CHECK??null,launcher:process.env.PICC_LAUNCHER_PID??null})+"\\n")',
    ].join(";");
    const command = `${JSON.stringify(process.execPath)} -e ${JSON.stringify(childScript)}`;
    const live = await startPi({
      launcherPath: path.join(REPO_ROOT, "bin", "picc.mjs"),
      script: [],
      prompt: "unused",
      modeArgs: ["--mode", "rpc"],
    });
    try {
      const requestId = "rpc-picc-user-bash";
      live.sendInput(JSON.stringify({ id: requestId, type: "bash", command }));
      const response = await live.waitForOutput((record) =>
        record.type === "response" && record.id === requestId, 30_000);
      expect(response).toMatchObject({ id: requestId, command: "bash", success: true });
      live.closeInput();
      const result = await live.completion;

      expect(result.code, result.stderr).toBe(0);
      expect(result.requests).toHaveLength(0);
      const records = readJsonLines(result.stdout);
      expect(records.filter((record) => record.type === "response" && record.id === requestId))
        .toEqual([expect.objectContaining({ command: "bash", success: true })]);
      const markerLines = fs.readFileSync(path.join(result.fixture, "rpc-bash-marker.json"), "utf8")
        .trim().split(/\r?\n/u);
      expect(markerLines).toHaveLength(1);
      expect(JSON.parse(markerLines[0]!)).toEqual({ skip: null, launcher: null });
    } finally {
      live.closeInput();
      await live.stop();
    }
  },
  TEST_TIMEOUT_MS,
);

describe.skipIf(cliMissing)("e2e core: real Pi CLI + PiCC extension + mock OpenAI model", () => {
  if (cliMissing) {
    // eslint-disable-next-line no-console
    console.warn(
      `Skipping live e2e tests: Pi CLI not found at ${CLI_PATH} — run npm install first.`,
    );
  }

  it(
    "intercepts a plugin-management command in real Pi text-print mode without provider egress",
    async () => {
      const result = await runPi({ script: [], prompt: "/plugin install ignored" });
      expect(result.requests).toHaveLength(0);
      expect(result.stdout).toContain("Read-only usage: /plugin list | /plugin details <plugin@marketplace>");
      expect(result.stdout).toContain("Run /plugin list to copy an exact qualified identity");
      expect(result.stdout).toContain("No changes were made");
      expect(result.stdout).toContain("Manage plugin installation and enablement in Claude Code.");
      expect(result.stdout).toContain("canonical /reload in the interactive TUI or exit and relaunch PiCC");
      expect(result.stdout).not.toContain("install ignored");
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "keeps compact search presentation out of print output and the next model request",
    async () => {
      const result = await runPi({
        script: [
          {
            toolCalls: [{
              name: "Grep",
              args: { pattern: "MODEL_BOUNDARY_NEEDLE", path: "search-target.txt", output_mode: "content" },
            }],
          },
          { text: "SEARCH_BOUNDARY_COMPLETE" },
        ],
        prompt: "search once",
        setup(fixtureDir) {
          fs.writeFileSync(
            path.join(fixtureDir, "search-target.txt"),
            "MODEL_BOUNDARY_NEEDLE first distinct payload\nbetween\nMODEL_BOUNDARY_NEEDLE second distinct payload\n",
          );
        },
      });

      expect(result.code).toBe(0);
      expect(result.requests).toHaveLength(2);
      const expected = [
        "search-target.txt:1:MODEL_BOUNDARY_NEEDLE first distinct payload",
        "search-target.txt:3:MODEL_BOUNDARY_NEEDLE second distinct payload",
      ].join("\n");
      const nextToolMessage = toolResultText(result.requests[1]!);
      expect(nextToolMessage).toBe(expected);
      expect(nextToolMessage).not.toContain("Grep “MODEL_BOUNDARY_NEEDLE”");
      expect(nextToolMessage).not.toContain("2/2 entries");
      expect(nextToolMessage).not.toMatch(TOOL_ROW_PRESENTATION);

      const stdout = result.stdout.replace(/\r\n/g, "\n");
      expect(stdout).toContain("SEARCH_BOUNDARY_COMPLETE");
      expect(stdout).not.toContain("Grep “MODEL_BOUNDARY_NEEDLE”");
      expect(stdout).not.toContain("2/2 entries");
      expect(stdout).not.toMatch(TOOL_ROW_PRESENTATION);
      expect(result.stderr).not.toMatch(TOOL_ROW_PRESENTATION);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "compacts a completed real-Pi tool batch before exactly one resumed ordinary request",
    async () => {
      const summaryGate = createResponseGate();
      const summaryCanary = "MODEL_SUMMARY_CANARY_T05";
      const secretSentinel = "SECRET_T05_MUST_NOT_RENDER";
      const pathSentinel = "C:/private/t05-never-render";
      const live = await startPi({
        persistSession: true,
        contextWindow: CHECKPOINT_CONTEXT_WINDOW,
        piSettings: CHECKPOINT_PI_SETTINGS,
        setup(fixtureDir) {
          writeCheckpointConfig(fixtureDir);
          fs.writeFileSync(
            path.join(fixtureDir, ".claude", "settings.json"),
            JSON.stringify({ permissions: { deny: ["Read(.env)", "Write(.env)"] } }),
          );
          fs.writeFileSync(path.join(fixtureDir, ".env"), "SECRET=TOP-SECRET-VALUE\n");
        },
        script: [
          {
            toolCalls: [
              { name: "write", args: { path: "batch-a.txt", content: "result-a" } },
              { name: "write", args: { path: "batch-b.txt", content: "result-b" } },
              { name: "read", args: { path: ".env" } },
              { name: "write", args: { path: ".env", content: "must not land" } },
            ],
            usage: CHECKPOINT_USAGE,
          },
          { text: summaryCanary, gate: summaryGate },
          { text: "RESUMED_FINAL_T05" },
        ],
        prompt: `complete both writes; internal sentinels ${secretSentinel} ${pathSentinel}`,
      });
      try {
        const summaryRequest = await summaryGate.entered;
        expect(summaryRequest).toMatchObject({ requestKind: "compaction", sessionKind: "main" });
        const summaryInput = allText(summaryRequest);
        expect(summaryInput).toContain("Successfully wrote");
        expect(summaryInput).toContain("PiCC: blocked by permission deny rule Read(.env)");
        expect(summaryInput).toContain("PiCC: blocked by permission deny rule Write(.env)");
        expect(summaryInput).not.toContain("TOP-SECRET-VALUE");
        expect(live.requests.map((request) => request.requestKind)).toEqual(["ordinary", "compaction"]);
        summaryGate.release();
        await live.waitForRequest((request) => request.requestKind === "ordinary", 2);
        const result = await live.completion;

        expect(result.code).toBe(0);
        expect(fs.readFileSync(path.join(result.fixture, "batch-a.txt"), "utf8")).toBe("result-a");
        expect(fs.readFileSync(path.join(result.fixture, "batch-b.txt"), "utf8")).toBe("result-b");
        expect(fs.readFileSync(path.join(result.fixture, ".env"), "utf8")).toBe("SECRET=TOP-SECRET-VALUE\n");
        for (const [index, request] of result.requests.entries()) {
          expect(allText(request), `request ${index} must not leak .env content`).not.toContain(
            "TOP-SECRET-VALUE",
          );
        }
        expect(result.requests.map((request) => `${request.sessionKind}/${request.requestKind}`)).toEqual([
          "main/ordinary",
          "main/compaction",
          "main/ordinary",
        ]);
        expect(
          result.stdout,
          `resumed request completed but print result was absent; stderr=${JSON.stringify(result.stderr)} trace=${result.requests.map((request) => `${request.sessionKind}/${request.requestKind}`).join(",")}`,
        ).toContain("RESUMED_FINAL_T05");
        expect(result.stdout.match(/RESUMED_FINAL_T05/g)).toHaveLength(1);
        expect(result.stderr).not.toContain("RESUMED_FINAL_T05");
        expect(`${result.stdout}\n${result.stderr}`).not.toContain(secretSentinel);
        expect(`${result.stdout}\n${result.stderr}`).not.toContain(pathSentinel);

        const sessionFiles: string[] = [];
        const walk = (dir: string) => {
          for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) walk(full);
            else if (entry.name.endsWith(".jsonl")) sessionFiles.push(full);
          }
        };
        walk(path.join(result.agentDir, "sessions"));
        const mainFile = sessionFiles.find((file) => !file.includes(".subagents"));
        expect(mainFile).toBeDefined();
        const manager = SessionManager.open(mainFile!);
        const entries = manager.getEntries();
        const compactions = entries.filter((entry) => entry.type === "compaction");
        expect(compactions).toHaveLength(1);
        expect((compactions[0] as { summary: string }).summary).toContain(summaryCanary);
        const context = JSON.stringify(manager.buildSessionContext().messages);
        expect(context.match(/RESUMED_FINAL_T05/g)).toHaveLength(1);
      } finally {
        summaryGate.release();
        await live.stop();
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "fails fast after one deterministic HTTP 400 compaction transaction without resuming",
    async () => {
      const errorSentinels = ["COMPACT_ERROR_SECRET_T05", "C:/private/compact/session.jsonl", "COMPACT_TRANSCRIPT_T05"];
      const result = await runPi({
        persistSession: true,
        contextWindow: CHECKPOINT_CONTEXT_WINDOW,
        piSettings: CHECKPOINT_PI_SETTINGS,
        setup(fixtureDir) {
          writeCheckpointConfig(fixtureDir);
        },
        script: [
          { toolCalls: [{ name: "write", args: { path: "deterministic.txt", content: "complete" } }], usage: CHECKPOINT_USAGE },
          { when: (request) => request.requestKind === "compaction", error: { status: 400, sticky: false, message: errorSentinels.join(" ") } },
          { text: "ORDINARY_MUST_NOT_RUN_AFTER_HTTP_400" },
        ],
        prompt: "run deterministic compaction failure",
      });

      expect(result.code).toBe(1);
      expect(result.requests.map((request) => request.requestKind)).toEqual(["ordinary", "compaction"]);
      expect(`${result.stdout}\n${result.stderr}`).not.toContain("ORDINARY_MUST_NOT_RUN_AFTER_HTTP_400");
      const files: string[] = [];
      const walk = (dir: string) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) walk(full);
          else if (entry.name.endsWith(".jsonl") && !full.includes(".subagents")) files.push(full);
        }
      };
      walk(path.join(result.agentDir, "sessions"));
      const entries = SessionManager.open(files[0]!).getEntries();
      expect(entries.filter((entry) => entry.type === "compaction")).toHaveLength(0);
      const visible = `${result.stdout}\n${result.stderr}\n${JSON.stringify(entries)}`;
      for (const sentinel of errorSentinels) expect(visible).not.toContain(sentinel);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "orders real JSON lifecycle records before one resumed terminal assistant message",
    async () => {
      const result = await runPi({
        modeArgs: ["--mode", "json", "-p", "run the JSON checkpoint"],
        contextWindow: CHECKPOINT_CONTEXT_WINDOW,
        piSettings: CHECKPOINT_PI_SETTINGS,
        setup(fixtureDir) {
          writeCheckpointConfig(fixtureDir);
        },
        script: [
          { toolCalls: [{ name: "write", args: { path: "json-cycle.txt", content: "complete" } }], usage: CHECKPOINT_USAGE },
          { text: "JSON_SUMMARY_T05" },
          { text: "JSON_RESUMED_FINAL_T05" },
        ],
        prompt: "unused mode-args prompt",
      });

      expect(result.code).toBe(0);
      expect(result.requests.map((request) => request.requestKind)).toEqual(["ordinary", "compaction", "ordinary"]);
      const records = result.stdout.trim().split(/\r?\n/).map((line) => JSON.parse(line) as any);
      expect(result.stdout).not.toMatch(TOOL_ROW_PRESENTATION);
      expect(result.stderr).not.toMatch(TOOL_ROW_PRESENTATION);
      expectNoToolRowPresentation(records, "decoded JSON output");
      expectCanonicalWriteResult(records, "Successfully wrote 8 bytes to json-cycle.txt");
      const resumedLifecycle = records.findIndex((record) =>
        record.type === "entry_appended" && record.entry?.customType === "picc-checkpoint-lifecycle" &&
        record.entry?.data?.category === "checkpoint-resumed");
      const finalMessages = records.filter((record) =>
        record.type === "message_end" && JSON.stringify(record.message).includes("JSON_RESUMED_FINAL_T05"));
      expect(resumedLifecycle).toBeGreaterThanOrEqual(0);
      expect(finalMessages).toHaveLength(1);
      expect(records.indexOf(finalMessages[0])).toBeGreaterThan(resumedLifecycle);
      const physicalEnds = records.filter((record) => record.type === "agent_end");
      expect(physicalEnds).toHaveLength(2);
      expect(JSON.stringify(physicalEnds.at(-1))).toContain("JSON_RESUMED_FINAL_T05");
      const settlements = records
        .map((record, index) => ({ record, index }))
        .filter(({ record }) => record.type === "agent_settled");
      const finalIndex = records.indexOf(finalMessages[0]);
      const physicalSettlements = settlements.slice(0, -1);
      const logicalSettlements = settlements.slice(-1);
      expect(physicalSettlements).toHaveLength(1);
      expect(physicalSettlements[0]!.index).toBeGreaterThan(finalIndex);
      expect(logicalSettlements.filter(({ index }) => index < finalIndex)).toHaveLength(0);
      expect(logicalSettlements.filter(({ index }) => index > finalIndex)).toHaveLength(1);
      expect(records.at(-1)).toBe(logicalSettlements[0]!.record);
      expect(fs.readFileSync(path.join(result.fixture, "json-cycle.txt"), "utf8")).toBe("complete");
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "does not replay a consumed streaming RPC prompt after later proactive compaction",
    async () => {
      const initialGate = createResponseGate();
      const sentinelGate = createResponseGate();
      const summaryGate = createResponseGate();
      const consumedSentinel = "RPC_CONSUMED_BEFORE_ARM_T02";
      const pendingSentinel = "RPC_PENDING_DURING_COMPACTION_T02";
      const initialPrompt = "run RPC checkpoint replay witness";
      const userTurn = (text: string) => [{ type: "text", text }];
      const userTurns = (request: { messages: Array<Record<string, unknown>> }) => request.messages
        .filter((message) => message.role === "user")
        .map((message) => message.content);
      const exactUserTurnText = (content: unknown): string | undefined =>
        Array.isArray(content) && content.length === 1 &&
          content[0]?.type === "text" && typeof content[0]?.text === "string"
          ? content[0].text
          : undefined;
      const exactOccurrences = (turns: readonly unknown[], text: string) =>
        turns.filter((turn) => exactUserTurnText(turn) === text);
      const live = await startPi({
        contextWindow: CHECKPOINT_CONTEXT_WINDOW,
        piSettings: CHECKPOINT_PI_SETTINGS,
        setup(fixtureDir) {
          writeCheckpointConfig(fixtureDir);
        },
        script: [
          { text: "RPC_INITIAL_BELOW_THRESHOLD_T02", gate: initialGate },
          {
            toolCalls: [{ name: "write", args: { path: "rpc-cycle.txt", content: "complete" } }],
            usage: CHECKPOINT_USAGE,
            gate: sentinelGate,
          },
          { text: "RPC_SUMMARY_T02", gate: summaryGate },
          { text: "RPC_HIDDEN_CONTINUATION_T02" },
          { text: "RPC_PENDING_FINAL_T02" },
        ],
        prompt: "unused",
        modeArgs: ["--mode", "rpc"],
      });
      try {
        live.sendInput(JSON.stringify({ id: "rpc-initial-t02", type: "prompt", message: initialPrompt }));
        const initialAck = await live.waitForOutput((record) =>
          record.type === "response" && record.id === "rpc-initial-t02", 30_000);
        expect(initialAck).toMatchObject({ command: "prompt", success: true });
        await initialGate.entered;

        live.sendInput(JSON.stringify({
          id: "rpc-sentinel-t02",
          type: "prompt",
          message: consumedSentinel,
          streamingBehavior: "steer",
        }));
        const sentinelAck = await live.waitForOutput((record) =>
          record.type === "response" && record.id === "rpc-sentinel-t02", 30_000);
        expect(sentinelAck).toMatchObject({ command: "prompt", success: true });
        initialGate.release();

        const sentinelRequest = await sentinelGate.entered;
        expect(live.requests.map((request) => request.requestKind)).toEqual(["ordinary", "ordinary"]);
        expect(userTurns(live.requests[0]!)).toEqual([userTurn(initialPrompt)]);
        expect(userTurns(sentinelRequest).slice(-2)).toEqual([
          userTurn(initialPrompt), userTurn(consumedSentinel),
        ]);
        sentinelGate.release();

        const summaryRequest = await summaryGate.entered;
        expect(summaryRequest).toMatchObject({ requestKind: "compaction", sessionKind: "main" });
        expect(live.requests.map((request) => request.requestKind)).toEqual([
          "ordinary", "ordinary", "compaction",
        ]);
        const beforePendingAdmission = live.requests
          .filter((request) => request.requestKind === "ordinary")
          .flatMap(userTurns);
        expect(exactOccurrences(beforePendingAdmission, pendingSentinel)).toHaveLength(0);

        live.sendInput(JSON.stringify({
          id: "rpc-pending-t02",
          type: "prompt",
          message: pendingSentinel,
        }));
        const pendingAck = await live.waitForOutput((record) =>
          record.type === "response" && record.id === "rpc-pending-t02", 30_000);
        expect(pendingAck).toMatchObject({ command: "prompt", success: true });
        expect(live.requests).toHaveLength(3);
        summaryGate.release();

        await live.waitForRequest((request) => request.requestKind === "ordinary", 3, 30_000);
        await live.waitForOutput((record) => record.type === "message_end" &&
          JSON.stringify(record).includes("RPC_HIDDEN_CONTINUATION_T02"), 30_000);
        await live.waitForRequest((request) => request.requestKind === "ordinary", 4, 30_000);
        await live.waitForOutput((record) => record.type === "message_end" &&
          JSON.stringify(record).includes("RPC_PENDING_FINAL_T02"), 30_000);
        await live.waitForOutput((record) => record.type === "agent_settled", 30_000, 2);
        live.closeInput();
        const result = await live.completion;
        if (process.platform === "win32" && result.code !== 0) {
          expect(result.code).toBe(3221226505);
          expect(result.stderr).toContain("UV_HANDLE_CLOSING");
        } else {
          expect(result.code, result.stderr).toBe(0);
        }
        expect(result.requests.map((request) => request.requestKind)).toEqual([
          "ordinary", "ordinary", "compaction", "ordinary", "ordinary",
        ]);
        const ordinaryRequests = result.requests.filter((request) => request.requestKind === "ordinary");
        const orderedUserTurns = ordinaryRequests.map(userTurns);
        expect(orderedUserTurns[0]).toEqual([userTurn(initialPrompt)]);
        expect(orderedUserTurns[1]).toEqual([
          userTurn(initialPrompt), userTurn(consumedSentinel),
        ]);
        expect(exactOccurrences(orderedUserTurns[0]!, consumedSentinel)).toHaveLength(0);
        expect(exactOccurrences(orderedUserTurns[1]!, consumedSentinel)).toHaveLength(1);
        expect(exactOccurrences(orderedUserTurns[2]!, consumedSentinel)).toHaveLength(0);
        expect(exactOccurrences(orderedUserTurns[3]!, consumedSentinel)).toHaveLength(0);
        expect(exactOccurrences(orderedUserTurns[0]!, pendingSentinel)).toHaveLength(0);
        expect(exactOccurrences(orderedUserTurns[1]!, pendingSentinel)).toHaveLength(0);
        expect(exactOccurrences(orderedUserTurns[2]!, pendingSentinel)).toHaveLength(0);
        expect(exactOccurrences(orderedUserTurns[3]!, pendingSentinel)).toHaveLength(1);
        expect(orderedUserTurns[3]!.at(-1)).toEqual(userTurn(pendingSentinel));
        const records = result.stdout.trim().split(/\r?\n/u).map((line) => JSON.parse(line) as any);
        expect(result.stdout).not.toMatch(TOOL_ROW_PRESENTATION);
        expect(result.stderr).not.toMatch(TOOL_ROW_PRESENTATION);
        expectNoToolRowPresentation(records, "decoded RPC output");
        expectCanonicalWriteResult(records, "Successfully wrote 8 bytes to rpc-cycle.txt");
        const lifecycle = records.filter((record) => record.type === "entry_appended" &&
          record.entry?.customType === "picc-checkpoint-lifecycle");
        expect(lifecycle.map((record) => record.entry.data.category)).toEqual([
          "checkpoint-armed", "checkpoint-complete", "checkpoint-resumed",
        ]);
        expect(lifecycle.every((record) => record.id === undefined)).toBe(true);
        expect(records.filter((record) => record.type === "response" &&
          ["rpc-initial-t02", "rpc-sentinel-t02", "rpc-pending-t02"].includes(record.id))).toHaveLength(3);
        const hiddenTerminal = records.filter((record) => record.type === "message_end" &&
          JSON.stringify(record).includes("RPC_HIDDEN_CONTINUATION_T02"));
        const pendingTerminal = records.filter((record) => record.type === "message_end" &&
          JSON.stringify(record).includes("RPC_PENDING_FINAL_T02"));
        expect(hiddenTerminal).toHaveLength(1);
        expect(pendingTerminal).toHaveLength(1);
        const hiddenTerminalIndex = records.indexOf(hiddenTerminal[0]);
        const pendingTerminalIndex = records.indexOf(pendingTerminal[0]);
        expect(pendingTerminalIndex).toBeGreaterThan(hiddenTerminalIndex);
        const settlements = records
          .map((record, index) => ({ record, index }))
          .filter(({ record }) => record.type === "agent_settled");
        const physicalSettlements = settlements.slice(0, -1);
        const logicalSettlements = settlements.slice(-1);
        expect(physicalSettlements).toHaveLength(1);
        expect(physicalSettlements[0]!.index).toBeGreaterThan(pendingTerminalIndex);
        expect(logicalSettlements.filter(({ index }) => index < pendingTerminalIndex)).toHaveLength(0);
        expect(logicalSettlements.filter(({ index }) => index > pendingTerminalIndex)).toHaveLength(1);
        expect(records.at(-1)).toBe(logicalSettlements[0]!.record);
      } finally {
        initialGate.release();
        sentinelGate.release();
        summaryGate.release();
        live.closeInput();
        await live.stop();
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "repeats compaction through Pi native cancellation before public RPC settlement",
    async () => {
      const firstSummaryGate = createResponseGate();
      const hiddenContinuationGate = createResponseGate();
      const resumedHighUsageGate = createResponseGate();
      const fallbackSummaryGate = createResponseGate();
      const fallbackPrefixGate = createResponseGate();
      const finalGate = createResponseGate();
      const initialPromptCanary = "RPC_REPEAT_INITIAL_T02";
      const hiddenContinuation = "Continue the paused work.";
      const collisionPrompt = "RPC_REPEAT_COLLISION_PROMPT_T02";
      const retainedOnlyCanary = "RPC_REPEAT_RETAINED_ONLY_T02";
      const usefulPrompt = "RPC_REPEAT_USEFUL_PROMPT_T02";
      const hiddenCanary = "RPC_REPEAT_HIDDEN_T02";
      const finalCanary = "RPC_REPEAT_FINAL_T02";
      const firstSummaryCanary = "RPC_REPEAT_SUMMARY_ONE_T02";
      const secondSummaryCanary = "RPC_REPEAT_SUMMARY_TWO_T02";
      const secondPrefixCanary = "RPC_REPEAT_SUMMARY_TWO_PREFIX_T02";
      const initialDiscardBegin = "RPC_REPEAT_INITIAL_DISCARD_BEGIN_T02";
      const initialDiscardEnd = "RPC_REPEAT_INITIAL_DISCARD_END_T02";
      const initialRetainedCanary = "RPC_REPEAT_INITIAL_RETAINED_ONLY_T02";
      const postSummaryDiscardBegin = "RPC_REPEAT_POST_DISCARD_BEGIN_T02";
      const postSummaryDiscardEnd = "RPC_REPEAT_POST_DISCARD_END_T02";
      const initialDiscardable = `${initialDiscardBegin}\n${"initial compressible checkpoint content ".repeat(4_500)}\n${initialDiscardEnd}`;
      const initialPrompt = `${initialPromptCanary}\n${initialDiscardable}`;
      const initialRetained = `${initialRetainedCanary}\n${"initial retained compressible content ".repeat(4_000)}`;
      const postSummaryDiscardable = `${postSummaryDiscardBegin}\n${"post summary compressible checkpoint content ".repeat(4_500)}\n${postSummaryDiscardEnd}`;
      const collisionInput = `${collisionPrompt}\n${postSummaryDiscardable}`;
      const hiddenResponse = `${hiddenCanary}\n${retainedOnlyCanary}\n${"post summary retained compressible content ".repeat(4_000)}`;
      expect(Math.ceil(initialDiscardable.length / 4)).toBeGreaterThan(20_000);
      expect(Math.ceil(postSummaryDiscardable.length / 4)).toBeGreaterThan(20_000);
      const requestUserTurns = (messages: Array<Record<string, unknown>>): string[] => messages
        .filter((message) => message.role === "user")
        .map((message) => {
          if (typeof message.content === "string") return message.content;
          if (!Array.isArray(message.content)) return "";
          return message.content.map((block: any) =>
            block?.type === "text" && typeof block.text === "string" ? block.text : "").join("");
        });
      const live = await startPi({
        persistSession: true,
        contextWindow: CHECKPOINT_CONTEXT_WINDOW,
        piSettings: { compaction: { enabled: true } },
        setup(fixtureDir) {
          writeCheckpointConfig(fixtureDir);
        },
        script: [
          {
            when: (request) => request.requestKind === "ordinary" &&
              requestUserTurns(request.messages).includes(initialPrompt),
            toolCalls: [{ name: "write", args: { path: "rpc-repeat-initial.txt", content: initialRetained } }],
            usage: CHECKPOINT_USAGE,
          },
          {
            when: (request) => request.requestKind === "compaction",
            text: firstSummaryCanary,
            gate: firstSummaryGate,
          },
          {
            when: (request) => request.requestKind === "ordinary" &&
              requestUserTurns(request.messages).includes(hiddenContinuation),
            text: "RPC_REPEAT_INTERIM_T02",
            gate: hiddenContinuationGate,
          },
          {
            when: (request) => request.requestKind === "ordinary" &&
              requestUserTurns(request.messages).includes(collisionInput),
            text: hiddenResponse,
            usage: CHECKPOINT_USAGE,
            gate: resumedHighUsageGate,
          },
          {
            when: (request) => request.requestKind === "compaction" &&
              allText(request).includes(firstSummaryCanary),
            text: secondSummaryCanary,
            gate: fallbackSummaryGate,
          },
          {
            when: (request) => request.requestKind === "compaction" &&
              allText(request).includes(postSummaryDiscardBegin),
            text: secondPrefixCanary,
            gate: fallbackPrefixGate,
          },
          {
            when: (request) => request.requestKind === "ordinary" &&
              requestUserTurns(request.messages).includes(usefulPrompt),
            text: finalCanary,
            gate: finalGate,
          },
        ],
        prompt: "unused",
        modeArgs: ["--mode", "rpc"],
      });
      const waitForOutput = async (
        label: string,
        predicate: (record: Record<string, unknown>) => boolean,
        count = 1,
      ): Promise<Record<string, unknown>> => {
        try {
          return await live.waitForOutput(predicate, 30_000, count);
        } catch (error) {
          throw new Error(`Failed while waiting for ${label}`, { cause: error });
        }
      };
      try {
        live.sendInput(JSON.stringify({
          id: "rpc-repeat-initial-t02",
          type: "prompt",
          message: initialPrompt,
        }));
        const initialAck = await waitForOutput("initial prompt acknowledgement", (record) =>
          record.type === "response" && record.id === "rpc-repeat-initial-t02");
        expect(initialAck).toMatchObject({ command: "prompt", success: true });
        const initialRequest = await live.waitForRequest(
          (request) => request.requestKind === "ordinary" &&
            requestUserTurns(request.messages).includes(initialPrompt),
          1,
          30_000,
        );
        expect(initialRequest).toMatchObject({ requestKind: "ordinary", sessionKind: "main" });
        await waitForOutput("initial tool result", (record) => record.type === "message_end" &&
          record.message !== null && typeof record.message === "object" &&
          (record.message as { role?: unknown }).role === "toolResult");
        const firstSummaryRequest = await live.waitForRequest(
          (request) => request.requestKind === "compaction", 1, 30_000,
        );
        expect(firstSummaryRequest).toMatchObject({ requestKind: "compaction", sessionKind: "main" });
        expect(allText(firstSummaryRequest)).toContain(initialDiscardBegin);
        expect(allText(firstSummaryRequest)).toContain(initialDiscardEnd);
        expect(allText(firstSummaryRequest)).not.toContain(initialRetainedCanary);
        expect(allText(firstSummaryRequest)).not.toContain(postSummaryDiscardBegin);
        firstSummaryGate.release();

        const hiddenRequest = await live.waitForRequest(
          (request) => request.requestKind === "ordinary" &&
            requestUserTurns(request.messages).includes(hiddenContinuation),
          1,
          30_000,
        );
        expect(hiddenRequest).toMatchObject({ requestKind: "ordinary", sessionKind: "main" });
        live.sendInput(JSON.stringify({
          id: "rpc-repeat-collision-t02",
          type: "prompt",
          message: collisionInput,
          streamingBehavior: "steer",
        }));
        const collisionAck = await waitForOutput("collision prompt acknowledgement", (record) =>
          record.type === "response" && record.id === "rpc-repeat-collision-t02");
        expect(collisionAck).toMatchObject({ command: "prompt", success: true });
        hiddenContinuationGate.release();
        const resumedHighUsageRequest = await live.waitForRequest(
          (request) => request.requestKind === "ordinary" &&
            requestUserTurns(request.messages).includes(collisionInput),
          1,
          30_000,
        );
        expect(resumedHighUsageRequest).toMatchObject({ requestKind: "ordinary", sessionKind: "main" });
        resumedHighUsageGate.release();

        await waitForOutput("resumed high-usage agent_end", (record) => record.type === "agent_end" &&
          JSON.stringify(record).includes(hiddenCanary));
        await waitForOutput("native threshold compaction_start", (record) => record.type === "compaction_start" &&
          record.reason === "threshold");
        await waitForOutput("aborted native compaction_end", (record) => record.type === "compaction_end" &&
          record.reason === "threshold" && record.aborted === true);

        const fallbackSummaryRequest = await live.waitForRequest(
          (request) => request.requestKind === "compaction" &&
            allText(request).includes(firstSummaryCanary), 1, 30_000,
        );
        expect(fallbackSummaryRequest).toMatchObject({ requestKind: "compaction", sessionKind: "main" });
        expect(allText(fallbackSummaryRequest)).not.toContain(postSummaryDiscardBegin);
        expect(allText(fallbackSummaryRequest)).not.toContain(initialDiscardBegin);
        const fallbackHistoryPrompt = userText(fallbackSummaryRequest);
        const previousSummaryStart = fallbackHistoryPrompt.indexOf("<previous-summary>");
        const previousSummaryEnd = fallbackHistoryPrompt.indexOf("</previous-summary>");
        const conversationStart = fallbackHistoryPrompt.indexOf("<conversation>");
        const conversationEnd = fallbackHistoryPrompt.indexOf("</conversation>");
        expect(previousSummaryStart).toBeGreaterThanOrEqual(0);
        expect(previousSummaryEnd).toBeGreaterThan(previousSummaryStart);
        expect(conversationStart).toBeGreaterThanOrEqual(0);
        expect(conversationEnd).toBeGreaterThan(conversationStart);
        const firstSummaryOccurrence = fallbackHistoryPrompt.indexOf(firstSummaryCanary);
        expect(firstSummaryOccurrence).toBeGreaterThan(previousSummaryStart);
        expect(firstSummaryOccurrence).toBeLessThan(previousSummaryEnd);
        expect(fallbackHistoryPrompt.lastIndexOf(firstSummaryCanary)).toBe(firstSummaryOccurrence);
        expect(fallbackHistoryPrompt.slice(previousSummaryStart, previousSummaryEnd)).toContain(firstSummaryCanary);
        expect(fallbackHistoryPrompt.slice(conversationStart, conversationEnd)).not.toContain(firstSummaryCanary);
        fallbackSummaryGate.release();
        const fallbackPrefixRequest = await live.waitForRequest(
          (request) => request.requestKind === "compaction" &&
            allText(request).includes(postSummaryDiscardBegin), 1, 30_000,
        );
        expect(fallbackPrefixRequest).toMatchObject({ requestKind: "compaction", sessionKind: "main" });
        expect(allText(fallbackPrefixRequest)).toContain(postSummaryDiscardEnd);
        expect(allText(fallbackPrefixRequest)).not.toContain(retainedOnlyCanary);
        expect(live.requests.filter((request) => request.requestKind === "compaction")).toEqual([
          firstSummaryRequest, fallbackSummaryRequest, fallbackPrefixRequest,
        ]);
        fallbackPrefixGate.release();
        await waitForOutput("fallback manual compaction_end", (record) => record.type === "compaction_end" &&
          record.reason === "manual" && JSON.stringify(record).includes(secondPrefixCanary));
        await waitForOutput("resumed-run public settlement", (record) => record.type === "agent_settled", 2);

        live.sendInput(JSON.stringify({
          id: "rpc-repeat-useful-t02",
          type: "prompt",
          message: usefulPrompt,
        }));
        const usefulAck = await waitForOutput("useful prompt acknowledgement", (record) =>
          record.type === "response" && record.id === "rpc-repeat-useful-t02");
        expect(usefulAck).toMatchObject({ command: "prompt", success: true });
        const finalRequest = await live.waitForRequest(
          (request) => request.requestKind === "ordinary" &&
            requestUserTurns(request.messages).includes(usefulPrompt),
          1,
          30_000,
        );
        expect(finalRequest).toMatchObject({ requestKind: "ordinary", sessionKind: "main" });
        finalGate.release();
        await waitForOutput("final useful response", (record) => record.type === "message_end" &&
          JSON.stringify(record).includes(finalCanary));
        await waitForOutput("final-input public settlement", (record) => record.type === "agent_settled", 3);

        live.closeInput();
        const result = await live.completion;
        expect(result.requests.map((request) => request.requestKind)).toEqual([
          "ordinary", "compaction", "ordinary", "ordinary", "compaction", "compaction", "ordinary",
        ]);
        expect(result.requests).toEqual([
          initialRequest,
          firstSummaryRequest,
          hiddenRequest,
          resumedHighUsageRequest,
          fallbackSummaryRequest,
          fallbackPrefixRequest,
          finalRequest,
        ]);
        const summaryRequests = result.requests.filter((request) => request.requestKind === "compaction");
        expect(summaryRequests).toHaveLength(3);
        expect(summaryRequests.every((request) =>
          systemText(request).includes("You are a context summarization assistant."))).toBe(true);
        expect(summaryRequests.map((request) =>
          allText(request).includes("This is the PREFIX of a turn that was too large to keep."))).toEqual([
          true, false, true,
        ]);
        const ordinaryRequests = result.requests.filter((request) => request.requestKind === "ordinary");
        expect(ordinaryRequests.filter((request) =>
          requestUserTurns(request.messages).includes(usefulPrompt))).toEqual([
          finalRequest,
        ]);
        expect(`${result.stdout}\n${result.stderr}`).not.toMatch(/checkpoint-(?:exhausted|cancelled)/u);
        expect(`${result.stdout}\n${result.stderr}`).not.toContain("restart the process");

        const records = result.stdout.trim().split(/\r?\n/u).map((line) => JSON.parse(line) as any);
        const indexed = (predicate: (record: any) => boolean) => records
          .map((record, index) => ({ record, index }))
          .filter(({ record }) => predicate(record));
        const singleIndex = (label: string, predicate: (record: any) => boolean): number => {
          const matches = indexed(predicate);
          expect(matches, label).toHaveLength(1);
          return matches[0]!.index;
        };
        const resumedAgentEnd = singleIndex("resumed high-usage agent_end", (record) =>
          record.type === "agent_end" && JSON.stringify(record).includes(hiddenCanary));
        const nativeStart = singleIndex("native threshold start", (record) =>
          record.type === "compaction_start" && record.reason === "threshold");
        const nativeEnd = singleIndex("aborted native threshold end", (record) =>
          record.type === "compaction_end" && record.reason === "threshold" && record.aborted === true);
        const manualStarts = indexed((record) => record.type === "compaction_start" && record.reason === "manual");
        const manualEnds = indexed((record) => record.type === "compaction_end" &&
          record.reason === "manual" && record.aborted === false);
        expect(manualStarts).toHaveLength(2);
        expect(manualEnds).toHaveLength(2);
        const fallbackStart = manualStarts[1]!.index;
        const fallbackEnd = manualEnds[1]!.index;
        expect(manualStarts[0]!.index).toBeLessThan(manualEnds[0]!.index);
        expect(manualEnds[0]!.index).toBeLessThan(resumedAgentEnd);
        expect(resumedAgentEnd).toBeLessThan(nativeStart);
        expect(nativeStart).toBeLessThan(nativeEnd);
        expect(nativeEnd).toBeLessThan(fallbackStart);
        expect(fallbackStart).toBeLessThan(fallbackEnd);
        expect(records[nativeEnd]).not.toHaveProperty("result");
        expect(JSON.stringify(records[fallbackEnd])).toContain(secondSummaryCanary);
        expect(indexed((record) => record.type === "compaction_start")).toHaveLength(3);
        expect(indexed((record) => record.type === "compaction_end")).toHaveLength(3);

        const usefulAckIndex = singleIndex("useful prompt acknowledgement", (record) =>
          record.type === "response" && record.id === "rpc-repeat-useful-t02");
        const finalCanaryIndex = singleIndex("final assistant response", (record) =>
          record.type === "message_end" && record.message?.role === "assistant" &&
          record.message.content?.some((block: any) => block.type === "text" && block.text === finalCanary));
        const settlements = indexed((record) => record.type === "agent_settled");
        expect(settlements).toHaveLength(3);
        const parentSettlements = settlements.filter(({ index }) =>
          index > resumedAgentEnd && index < fallbackEnd);
        const resumedSettlements = settlements.filter(({ index }) =>
          index > fallbackEnd && index < usefulAckIndex);
        const finalSettlements = settlements.filter(({ index }) => index > finalCanaryIndex);
        expect(parentSettlements).toHaveLength(1);
        expect(parentSettlements[0]!.index).toBeGreaterThan(fallbackStart);
        expect(resumedSettlements).toHaveLength(1);
        expect(finalSettlements).toHaveLength(1);
        expect(parentSettlements[0]!.index).toBeLessThan(resumedSettlements[0]!.index);
        expect(resumedSettlements[0]!.index).toBeLessThan(usefulAckIndex);
        expect(usefulAckIndex).toBeLessThan(finalCanaryIndex);
        expect(finalCanaryIndex).toBeLessThan(finalSettlements[0]!.index);

        const lifecycle = records.filter((record) => record.type === "entry_appended" &&
          record.entry?.customType === "picc-checkpoint-lifecycle");
        expect(lifecycle.map((record) => [record.entry.data.generation, record.entry.data.category])).toEqual([
          [1, "checkpoint-armed"],
          [1, "checkpoint-complete"],
          [1, "checkpoint-resumed"],
          [2, "checkpoint-armed"],
          [2, "checkpoint-complete"],
        ]);

        const mainFiles = findSessionFiles(result.agentDir).filter((file) => !file.includes(".subagents"));
        expect(mainFiles).toHaveLength(1);
        const entries = SessionManager.open(mainFiles[0]!).getEntries() as any[];
        const compactions = entries.filter((entry) => entry.type === "compaction");
        expect(compactions).toHaveLength(2);
        expect(compactions.map((entry) => entry.summary)).toEqual([
          expect.stringContaining(firstSummaryCanary),
          expect.stringMatching(new RegExp(`${secondSummaryCanary}[\\s\\S]*${secondPrefixCanary}`, "u")),
        ]);
        const messageEntries = entries.filter((entry) => entry.type === "message");
        const exactText = (message: any): string | undefined => {
          if (typeof message.content === "string") return message.content;
          if (!Array.isArray(message.content) ||
            message.content.some((block: any) => block.type !== "text" || typeof block.text !== "string")) return undefined;
          return message.content.map((block: any) => block.text).join("");
        };
        const exactTurns = (role: string, text: string) => messageEntries.filter((entry) =>
          entry.message.role === role && exactText(entry.message) === text);
        const initialTurns = exactTurns("user", initialPrompt);
        const continuationEntries = entries.filter((entry) => entry.type === "custom_message" &&
          entry.customType === "picc-checkpoint-continuation" && entry.content === hiddenContinuation);
        const collisionTurns = exactTurns("user", collisionInput);
        const interimTurns = exactTurns("assistant", "RPC_REPEAT_INTERIM_T02");
        const hiddenTurns = exactTurns("assistant", hiddenResponse);
        const usefulTurns = exactTurns("user", usefulPrompt);
        const finalTurns = exactTurns("assistant", finalCanary);
        for (const [label, turns] of [
          ["initial user", initialTurns], ["hidden continuation", continuationEntries],
          ["interim assistant", interimTurns], ["collision user", collisionTurns],
          ["high-usage assistant", hiddenTurns], ["useful user", usefulTurns], ["final assistant", finalTurns],
        ] as const) expect(turns, label).toHaveLength(1);
        const writeCalls = (content: string, targetPath: string) => messageEntries.filter((entry) =>
          entry.message.role === "assistant" && Array.isArray(entry.message.content) &&
          entry.message.content.some((block: any) => block.type === "toolCall" && block.name === "write" &&
            block.arguments?.path === targetPath && block.arguments?.content === content));
        const initialWriteCalls = writeCalls(initialRetained, "rpc-repeat-initial.txt");
        expect(initialWriteCalls).toHaveLength(1);
        const entryIndex = (entry: any) => entries.indexOf(entry);
        const orderedEntries = [
          initialTurns[0], initialWriteCalls[0], compactions[0], continuationEntries[0], interimTurns[0],
          collisionTurns[0], hiddenTurns[0], compactions[1],
          usefulTurns[0], finalTurns[0],
        ];
        orderedEntries.forEach((entry) => expect(entry).toBeDefined());
        for (let index = 1; index < orderedEntries.length; index++) {
          expect(entryIndex(orderedEntries[index - 1])).toBeLessThan(entryIndex(orderedEntries[index]));
        }
        const persisted = JSON.stringify(entries);
        for (const canary of [
          initialPromptCanary, initialDiscardBegin, initialDiscardEnd, initialRetainedCanary, firstSummaryCanary,
          postSummaryDiscardBegin, postSummaryDiscardEnd, collisionPrompt, retainedOnlyCanary,
          hiddenCanary, secondSummaryCanary, secondPrefixCanary, usefulPrompt, finalCanary,
        ]) expect(persisted.match(new RegExp(canary, "g")), canary).toHaveLength(1);
        expect(fs.readFileSync(path.join(result.fixture, "rpc-repeat-initial.txt"), "utf8")).toBe(initialRetained);

        if (process.platform === "win32" && result.code !== 0) {
          expect(result.code).toBe(3221226505);
          expect(result.stderr).toContain("UV_HANDLE_CLOSING");
        } else {
          expect(result.code, result.stderr).toBe(0);
        }
      } finally {
        firstSummaryGate.release();
        hiddenContinuationGate.release();
        resumedHighUsageGate.release();
        fallbackSummaryGate.release();
        fallbackPrefixGate.release();
        finalGate.release();
        live.closeInput();
        await live.stop();
        try { await live.completion; } catch { /* process closure is confirmed; absorb harness finalization failure */ }
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "transfers a real Stop-blocked JSON continuation after compact hooks and withholds the outer final",
    async () => {
      const result = await runPi({
        persistSession: true,
        contextWindow: CHECKPOINT_CONTEXT_WINDOW,
        piSettings: CHECKPOINT_PI_SETTINGS,
        setup(fixtureDir) {
          const claudeDir = path.join(fixtureDir, ".claude");
          writeCheckpointConfig(fixtureDir);
          fs.writeFileSync(path.join(claudeDir, "stop-once"), "block");
          fs.writeFileSync(path.join(claudeDir, "settings.json"), JSON.stringify({ hooks: {
            PreCompact: [{ matcher: "auto", hooks: [{ type: "command", command: "echo 'PreCompact(auto)' >> \"$CLAUDE_PROJECT_DIR/hook-trace.txt\"" }] }],
            SessionStart: [{ matcher: "compact", hooks: [{ type: "command", command: "echo 'SessionStart(compact)' >> \"$CLAUDE_PROJECT_DIR/hook-trace.txt\"" }] }],
            PostCompact: [{ matcher: "auto", hooks: [{ type: "command", command: "echo 'PostCompact' >> \"$CLAUDE_PROJECT_DIR/hook-trace.txt\"" }] }],
            Stop: [{ hooks: [{ type: "command", command: "if [ -f \"$CLAUDE_PROJECT_DIR/.claude/stop-once\" ]; then echo 'Stop' >> \"$CLAUDE_PROJECT_DIR/hook-trace.txt\"; rm \"$CLAUDE_PROJECT_DIR/.claude/stop-once\"; echo 'finish after stop transfer' >&2; exit 2; fi" }] }],
          } }));
        },
        script: [
          { toolCalls: [{ name: "write", args: { path: "stop-transfer-a.txt", content: "complete-a" } }] },
          { toolCalls: [{ name: "write", args: { path: "stop-transfer-b.txt", content: "complete-b" } }], usage: CHECKPOINT_USAGE },
          { text: "STOP_TRANSFER_SUMMARY_T05" },
          { text: "INTERIM_MUST_NOT_BE_OUTER_FINAL" },
          { text: "STOP_TRANSFER_FINAL_T05" },
        ],
        prompt: "run stop transfer",
        modeArgs: ["--mode", "json", "-p", "run stop transfer"],
      });

      expect(result.code).toBe(0);
      expect(result.requests.map((request) => request.requestKind), `${result.stderr}\n${result.stdout}`).toEqual(["ordinary", "ordinary", "compaction", "ordinary", "ordinary"]);
      expect(fs.readFileSync(path.join(result.fixture, "hook-trace.txt"), "utf8").trim().split(/\r?\n/u)).toEqual([
        "PreCompact(auto)", "SessionStart(compact)", "PostCompact", "Stop",
      ]);
      const records = result.stdout.trim().split(/\r?\n/u).map((line) => JSON.parse(line) as any);
      const final = records.filter((record) => record.type === "message_end" &&
        JSON.stringify(record.message).includes("STOP_TRANSFER_FINAL_T05"));
      expect(final).toHaveLength(1);
      const finalIndex = records.indexOf(final[0]);
      const settlements = records
        .map((record, index) => ({ record, index }))
        .filter(({ record }) => record.type === "agent_settled");
      const physicalSettlements = settlements.slice(0, -1);
      const logicalSettlements = settlements.slice(-1);
      expect(physicalSettlements.filter(({ index }) => index < finalIndex)).toHaveLength(1);
      expect(physicalSettlements.filter(({ index }) => index > finalIndex)).toHaveLength(1);
      expect(logicalSettlements.filter(({ index }) => index < finalIndex)).toHaveLength(0);
      expect(logicalSettlements.filter(({ index }) => index > finalIndex)).toHaveLength(1);
      expect(records.at(-1)).toBe(logicalSettlements[0]!.record);
      const interimEnd = records.findIndex((record) => record.type === "message_end" &&
        JSON.stringify(record.message).includes("INTERIM_MUST_NOT_BE_OUTER_FINAL"));
      expect(interimEnd).toBeGreaterThanOrEqual(0);
      expect(records.indexOf(final[0])).toBeGreaterThan(interimEnd);
    },
    TEST_TIMEOUT_MS,
  );

  // --- Slash-skill expansion end-to-end via the input event ---
  it(
    "expands a /deploy slash skill into the user turn with positional args (full-surface)",
    async () => {
      const result = await runPi({
        fixture: "full-surface",
        script: [{ text: "done" }],
        prompt: "/deploy staging 7.7",
      });

      expect(result.code).toBe(0);
      expect(result.requests.length).toBeGreaterThanOrEqual(1);
      const first = result.requests[0]!;
      const names = toolNames(first);
      for (const expected of ["write", "read", "bash", "Skill", "Agent", "EnterWorktree"]) {
        expect(names, `tool ${expected} advertised`).toContain(expected);
      }
      const system = systemText(first);
      expect(system).toContain("FS-ROOT-CLAUDE-MD");
      expect(system).toContain("FS-IMPORT-HOP-1");
      expect(system).toContain("FS-IMPORT-HOP-2");
      expect(system).toContain("FS-CLAUDE-LOCAL-MD");
      expect(system).toContain("FS-RULE-UNCONDITIONAL");
      expect(system).toContain("Available subagents");
      expect(system).toMatch(/deploy:.*deploy/i);
      expect(system).not.toContain("FS-SKILL-FORK-BODY");
      expect(system).not.toContain("FS-SKILL-SHELL-BODY");

      const user = userText(first);
      expect(user).toContain("FS-SKILL-ARGS-BODY");
      expect(user).toContain("Deploy to environment **staging** at version **7.7**");
      // It expanded — the raw slash command is not what reached the model verbatim.
      expect(user).not.toMatch(/^\s*"?\/deploy staging 7\.7"?\s*$/);
    },
    TEST_TIMEOUT_MS,
  );
});

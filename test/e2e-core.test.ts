import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
  allText,
  CHECKPOINT_CONTEXT_WINDOW,
  CHECKPOINT_PI_SETTINGS,
  CHECKPOINT_USAGE,
  cliMissing,
  createE2ELive,
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

describe.skipIf(cliMissing)("e2e core: real Pi CLI + PiCC extension + mock OpenAI model", () => {
  if (cliMissing) {
    // eslint-disable-next-line no-console
    console.warn(
      `Skipping live e2e tests: Pi CLI not found at ${CLI_PATH} — run npm install first.`,
    );
  }

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
      const consumedSentinel = "RPC_CONSUMED_BEFORE_ARM_T02";
      const initialPrompt = "run RPC checkpoint replay witness";
      const userTurn = (text: string) => [{ type: "text", text }];
      const userTurns = (request: { messages: Array<Record<string, unknown>> }) => request.messages
        .filter((message) => message.role === "user")
        .map((message) => message.content);
      const isSentinelTurn = (content: unknown) => content === consumedSentinel ||
        (Array.isArray(content) && content.length === 1 &&
          content[0]?.type === "text" && content[0]?.text === consumedSentinel);
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
          { text: "RPC_SUMMARY_T02" },
          { text: "RPC_RESUMED_FINAL_T02" },
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

        await live.waitForRequest((request) => request.requestKind === "ordinary", 3, 30_000);
        await live.waitForOutput((record) => record.type === "message_end" &&
          JSON.stringify(record).includes("RPC_RESUMED_FINAL_T02"), 30_000);
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
          "ordinary", "ordinary", "compaction", "ordinary",
        ]);
        const ordinaryRequests = result.requests.filter((request) => request.requestKind === "ordinary");
        const orderedUserTurns = ordinaryRequests.map(userTurns);
        expect(orderedUserTurns[1]!.slice(-2)).toEqual([
          userTurn(initialPrompt), userTurn(consumedSentinel),
        ]);
        expect(isSentinelTurn(orderedUserTurns[1]!.at(-1))).toBe(true);
        expect(isSentinelTurn(orderedUserTurns[2]!.at(-1))).toBe(false);
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
          ["rpc-initial-t02", "rpc-sentinel-t02"].includes(record.id))).toHaveLength(2);
        const terminal = records.filter((record) => record.type === "message_end" &&
          JSON.stringify(record).includes("RPC_RESUMED_FINAL_T02"));
        expect(terminal).toHaveLength(1);
        const terminalIndex = records.indexOf(terminal[0]);
        const settlements = records
          .map((record, index) => ({ record, index }))
          .filter(({ record }) => record.type === "agent_settled");
        const physicalSettlements = settlements.slice(0, -1);
        const logicalSettlements = settlements.slice(-1);
        expect(physicalSettlements).toHaveLength(1);
        expect(physicalSettlements[0]!.index).toBeGreaterThan(terminalIndex);
        expect(logicalSettlements.filter(({ index }) => index < terminalIndex)).toHaveLength(0);
        expect(logicalSettlements.filter(({ index }) => index > terminalIndex)).toHaveLength(1);
        expect(records.at(-1)).toBe(logicalSettlements[0]!.record);
      } finally {
        initialGate.release();
        sentinelGate.release();
        live.closeInput();
        await live.stop();
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

import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
  allText,
  cliMissing,
  createE2ELive,
  systemText,
  toolResultText,
  TEST_TIMEOUT_MS,
  toolNames,
  userText,
  CLI_PATH,
} from "./helpers/e2e-live.js";
import { createResponseGate, type Turn } from "./helpers/mock-openai.js";

/**
 * E2E — core wiring: full Claude project context assembled into the real
 * model request, and a /deploy slash-skill expanded through Pi's input event.
 * See test/helpers/e2e-live.ts for the shared runPi harness.
 */

const { startPi, runPi, cleanup } = createE2ELive();
afterEach(cleanup);

describe.skipIf(cliMissing)("e2e core: real Pi CLI + PiCC extension + mock OpenAI model", () => {
  if (cliMissing) {
    // eslint-disable-next-line no-console
    console.warn(
      `Skipping live e2e tests: Pi CLI not found at ${CLI_PATH} — run npm install first.`,
    );
  }

  it(
    "assembles the Claude project context into the system prompt sent to the model",
    async () => {
      const result = await runPi({ script: [{ text: "hello" }], prompt: "say hello" });

      expect(result.code).toBe(0);
      expect(result.requests.length).toBeGreaterThanOrEqual(1);
      const first = result.requests[0]!;

      // Pi advertises both built-in (lower-case) and Claude-named tools.
      const names = toolNames(first);
      for (const expected of ["write", "read", "bash", "Skill", "Agent", "EnterWorktree"]) {
        expect(names, `tool ${expected} advertised`).toContain(expected);
      }

      const system = systemText(first);
      expect(system).toContain("ROOT-CLAUDE-MD-LOADED");
      expect(system).toContain("AGENTS-MD-IMPORTED");
      expect(system).toContain("STYLE-RULE-LOADED");
      expect(system).toContain("Available subagents");
      // The greet skill is listed by name+description...
      expect(system).toMatch(/greet: Greet a person by name/);
      // ...but its body stays lazy-loaded (NFR): not in context until activated.
      expect(allText(first)).not.toContain("GREET-SKILL-BODY");

      expect(result.stdout).toContain("hello");
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

      const stdout = result.stdout.replace(/\r\n/g, "\n");
      expect(stdout).toContain("SEARCH_BOUNDARY_COMPLETE");
      expect(stdout).not.toContain("Grep “MODEL_BOUNDARY_NEEDLE”");
      expect(stdout).not.toContain("2/2 entries");
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "compacts a completed real-Pi tool batch before exactly one resumed ordinary request",
    async () => {
      const summaryGate = createResponseGate();
      const highUsage = { prompt_tokens: 90_000, completion_tokens: 100, total_tokens: 90_100 };
      const summaryCanary = "MODEL_SUMMARY_CANARY_T05";
      const secretSentinel = "SECRET_T05_MUST_NOT_RENDER";
      const pathSentinel = "C:/private/t05-never-render";
      const live = await startPi({
        persistSession: true,
        contextWindow: 100_000,
        piSettings: {
          compaction: { enabled: false, reserveTokens: 100, keepRecentTokens: 1 },
        },
        setup(fixtureDir) {
          const configDir = path.join(fixtureDir, ".claude", ".picc");
          fs.mkdirSync(configDir, { recursive: true });
          fs.writeFileSync(path.join(configDir, "config.json"), JSON.stringify({ proactiveCompactPercent: 90 }));
        },
        script: [
          {
            toolCalls: [
              { name: "write", args: { path: "batch-a.txt", content: "result-a" } },
              { name: "write", args: { path: "batch-b.txt", content: "result-b" } },
            ],
            usage: highUsage,
          },
          { text: summaryCanary, gate: summaryGate },
          { text: "RESUMED_FINAL_T05" },
        ],
        prompt: `complete both writes; internal sentinels ${secretSentinel} ${pathSentinel}`,
      });
      try {
        const summaryRequest = await summaryGate.entered;
        expect(summaryRequest).toMatchObject({ requestKind: "compaction", sessionKind: "main" });
        expect(live.requests.map((request) => request.requestKind)).toEqual(["ordinary", "compaction"]);
        summaryGate.release();
        await live.waitForRequest((request) => request.requestKind === "ordinary", 2);
        const result = await live.completion;

        expect(result.code).toBe(0);
        expect(fs.readFileSync(path.join(result.fixture, "batch-a.txt"), "utf8")).toBe("result-a");
        expect(fs.readFileSync(path.join(result.fixture, "batch-b.txt"), "utf8")).toBe("result-b");
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
    "retries one failed real Pi compaction, commits only the successful model summary, then resumes once",
    async () => {
      const highUsage = { prompt_tokens: 90_000, completion_tokens: 100, total_tokens: 90_100 };
      const errorSentinels = ["COMPACT_ERROR_SECRET_T05", "C:/private/compact/session.jsonl", "COMPACT_TRANSCRIPT_T05"];
      const summaryCanary = "TRANSIENT_SUCCESS_SUMMARY_T05";
      const result = await runPi({
        persistSession: true,
        contextWindow: 100_000,
        piSettings: { compaction: { enabled: false, reserveTokens: 100, keepRecentTokens: 1 } },
        setup(fixtureDir) {
          const configDir = path.join(fixtureDir, ".claude", ".picc");
          fs.mkdirSync(configDir, { recursive: true });
          fs.writeFileSync(path.join(configDir, "config.json"), JSON.stringify({ proactiveCompactPercent: 90 }));
        },
        script: [
          { toolCalls: [{ name: "write", args: { path: "transient.txt", content: "complete" } }], usage: highUsage },
          { when: (request) => request.requestKind === "compaction", error: { status: 400, sticky: false, message: errorSentinels.join(" ") } },
          { when: (request) => request.requestKind === "compaction", text: summaryCanary },
          { text: "TRANSIENT_RESUMED_FINAL_T05" },
        ],
        prompt: "run transient compaction retry",
      });

      expect(result.code).toBe(0);
      expect(result.requests.map((request) => request.requestKind)).toEqual(["ordinary", "compaction", "compaction", "ordinary"]);
      expect(result.stdout.match(/TRANSIENT_RESUMED_FINAL_T05/g)).toHaveLength(1);
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
      const compactions = entries.filter((entry) => entry.type === "compaction");
      expect(compactions).toHaveLength(1);
      expect((compactions[0] as { summary: string }).summary).toContain(summaryCanary);
      const visible = `${result.stdout}\n${result.stderr}\n${JSON.stringify(entries)}`;
      for (const sentinel of errorSentinels) expect(visible).not.toContain(sentinel);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "exhausts three real Pi compactions without a summary or ordinary resume and keeps print exit semantics Pi-owned",
    async () => {
      const highUsage = { prompt_tokens: 90_000, completion_tokens: 100, total_tokens: 90_100 };
      const errorSentinels = ["EXHAUST_SECRET_T05", "C:/private/exhaust/session.jsonl", "EXHAUST_TRANSCRIPT_T05"];
      const failures: Turn[] = Array.from({ length: 3 }, () => ({
        when: (request) => request.requestKind === "compaction",
        error: { status: 400, sticky: false, message: errorSentinels.join(" ") },
      }));
      const result = await runPi({
        persistSession: true,
        contextWindow: 100_000,
        piSettings: { compaction: { enabled: false, reserveTokens: 100, keepRecentTokens: 1 } },
        setup(fixtureDir) {
          const configDir = path.join(fixtureDir, ".claude", ".picc");
          fs.mkdirSync(configDir, { recursive: true });
          fs.writeFileSync(path.join(configDir, "config.json"), JSON.stringify({ proactiveCompactPercent: 90 }));
        },
        script: [
          { toolCalls: [{ name: "write", args: { path: "exhausted.txt", content: "complete" } }], usage: highUsage },
          ...failures,
          { text: "ORDINARY_MUST_NOT_RUN_AFTER_EXHAUSTION" },
        ],
        prompt: "run exhausted compaction",
      });

      // Pi 0.80.6 owns print exit status and currently maps this exhausted
      // terminal API-error boundary to 1; PiCC only guarantees settlement.
      expect(result.code).toBe(1);
      expect(result.requests.map((request) => request.requestKind)).toEqual(["ordinary", "compaction", "compaction", "compaction"]);
      expect(`${result.stdout}\n${result.stderr}`).not.toContain("ORDINARY_MUST_NOT_RUN_AFTER_EXHAUSTION");
      expect(result.stderr).toContain("Run /compact, then explicitly continue");
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
      const highUsage = { prompt_tokens: 90_000, completion_tokens: 100, total_tokens: 90_100 };
      const result = await runPi({
        modeArgs: ["--mode", "json", "-p", "run the JSON checkpoint"],
        contextWindow: 100_000,
        piSettings: { compaction: { enabled: false, reserveTokens: 100, keepRecentTokens: 1 } },
        setup(fixtureDir) {
          const configDir = path.join(fixtureDir, ".claude", ".picc");
          fs.mkdirSync(configDir, { recursive: true });
          fs.writeFileSync(path.join(configDir, "config.json"), JSON.stringify({ proactiveCompactPercent: 90 }));
        },
        script: [
          { toolCalls: [{ name: "write", args: { path: "json-cycle.txt", content: "complete" } }], usage: highUsage },
          { text: "JSON_SUMMARY_T05" },
          { text: "JSON_RESUMED_FINAL_T05" },
        ],
        prompt: "unused mode-args prompt",
      });

      expect(result.code).toBe(0);
      expect(result.requests.map((request) => request.requestKind)).toEqual(["ordinary", "compaction", "ordinary"]);
      const records = result.stdout.trim().split(/\r?\n/).map((line) => JSON.parse(line) as any);
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
    "drives the real RPC entry through checkpoint lifecycle and acknowledges only the prompt command",
    async () => {
      const highUsage = { prompt_tokens: 90_000, completion_tokens: 100, total_tokens: 90_100 };
      const live = await startPi({
        contextWindow: 100_000,
        piSettings: { compaction: { enabled: false, reserveTokens: 100, keepRecentTokens: 1 } },
        setup(fixtureDir) {
          const configDir = path.join(fixtureDir, ".claude", ".picc");
          fs.mkdirSync(configDir, { recursive: true });
          fs.writeFileSync(path.join(configDir, "config.json"), JSON.stringify({ proactiveCompactPercent: 90 }));
        },
        script: [
          { toolCalls: [{ name: "write", args: { path: "rpc-cycle.txt", content: "complete" } }], usage: highUsage },
          { text: "RPC_SUMMARY_T05" },
          { text: "RPC_RESUMED_FINAL_T05" },
        ],
        prompt: "unused",
        modeArgs: ["--mode", "rpc"],
      });
      try {
        live.sendInput(JSON.stringify({ id: "rpc-prompt-t05", type: "prompt", message: "run RPC checkpoint" }));
        const ack = await live.waitForOutput((record) => record.type === "response" && record.id === "rpc-prompt-t05", 30_000);
        expect(ack).toMatchObject({ command: "prompt", success: true });
        await live.waitForRequest((request) => request.requestKind === "ordinary", 2, 30_000);
        await live.waitForOutput((record) => record.type === "message_end" &&
          JSON.stringify(record).includes("RPC_RESUMED_FINAL_T05"), 30_000);
        await live.waitForOutput((record) => record.type === "agent_settled", 30_000, 2);
        live.closeInput();
        const result = await live.completion;
        if (process.platform === "win32") {
          expect(result.code).toBe(3221226505);
          expect(result.stderr).toContain("UV_HANDLE_CLOSING");
        } else {
          expect(result.code, result.stderr).toBe(0);
        }
        expect(result.requests.map((request) => request.requestKind)).toEqual(["ordinary", "compaction", "ordinary"]);
        const records = result.stdout.trim().split(/\r?\n/u).map((line) => JSON.parse(line) as any);
        const lifecycle = records.filter((record) => record.type === "entry_appended" &&
          record.entry?.customType === "picc-checkpoint-lifecycle");
        expect(lifecycle.map((record) => record.entry.data.category)).toEqual([
          "checkpoint-armed", "checkpoint-complete", "checkpoint-resumed",
        ]);
        expect(lifecycle.every((record) => record.id === undefined)).toBe(true);
        expect(records.filter((record) => record.type === "response" && record.id === "rpc-prompt-t05")).toHaveLength(1);
        const terminal = records.filter((record) => record.type === "message_end" &&
          JSON.stringify(record).includes("RPC_RESUMED_FINAL_T05"));
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
        live.closeInput();
        await live.stop();
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "gates a subsequent real RPC prompt after three-attempt compaction exhaustion",
    async () => {
      const highUsage = { prompt_tokens: 90_000, completion_tokens: 100, total_tokens: 90_100 };
      const failures: Turn[] = Array.from({ length: 3 }, () => ({
        when: (request) => request.requestKind === "compaction",
        error: { status: 400, sticky: false, message: "RPC_EXHAUST_SECRET C:/private/rpc/session.jsonl RPC_TRANSCRIPT_SENTINEL" },
      }));
      const live = await startPi({
        contextWindow: 100_000,
        piSettings: { compaction: { enabled: false, reserveTokens: 100, keepRecentTokens: 1 } },
        setup(fixtureDir) {
          const configDir = path.join(fixtureDir, ".claude", ".picc");
          fs.mkdirSync(configDir, { recursive: true });
          fs.writeFileSync(path.join(configDir, "config.json"), JSON.stringify({ proactiveCompactPercent: 90 }));
        },
        script: [
          { toolCalls: [{ name: "write", args: { path: "rpc-exhaust.txt", content: "complete" } }], usage: highUsage },
          ...failures,
          { text: "RPC_ORDINARY_MUST_STAY_GATED" },
        ],
        prompt: "unused",
        modeArgs: ["--mode", "rpc"],
      });
      try {
        live.sendInput(JSON.stringify({ id: "rpc-first", type: "prompt", message: "exhaust RPC checkpoint" }));
        await live.waitForOutput((record) => record.type === "entry_appended" &&
          (record.entry as any)?.data?.category === "checkpoint-exhausted", 30_000);
        live.sendInput(JSON.stringify({ id: "rpc-gated", type: "prompt", message: "must remain gated" }));
        await live.waitForOutput((record) => record.type === "response" && record.id === "rpc-gated", 30_000);
        live.closeInput();
        const result = await live.completion;
        expect(result.requests.map((request) => request.requestKind)).toEqual(["ordinary", "compaction", "compaction", "compaction"]);
        expect(`${result.stdout}\n${result.stderr}`).not.toContain("RPC_ORDINARY_MUST_STAY_GATED");
        const records = result.stdout.trim().split(/\r?\n/u).map((line) => JSON.parse(line) as any);
        expect(records.filter((record) => record.type === "response" && record.id === "rpc-gated")).toHaveLength(1);
        const piccLifecycle = records.filter((record) => record.type === "entry_appended" &&
          record.entry?.customType === "picc-checkpoint-lifecycle");
        expect(JSON.stringify(piccLifecycle)).not.toMatch(/RPC_EXHAUST_SECRET|private\/rpc|RPC_TRANSCRIPT_SENTINEL/);
        const nativeFailures = records.filter((record) => record.type === "compaction_end" && record.errorMessage);
        expect(JSON.stringify(nativeFailures)).toMatch(/RPC_EXHAUST_SECRET|private\/rpc|RPC_TRANSCRIPT_SENTINEL/);
        expect(result.code, result.stderr).toBe(0);
      } finally {
        live.closeInput();
        await live.stop();
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "transfers a real Stop-blocked JSON continuation after compact hooks and withholds the outer final",
    async () => {
      const highUsage = { prompt_tokens: 90_000, completion_tokens: 100, total_tokens: 90_100 };
      const result = await runPi({
        persistSession: true,
        contextWindow: 100_000,
        piSettings: { compaction: { enabled: false, reserveTokens: 100, keepRecentTokens: 1 } },
        setup(fixtureDir) {
          const claudeDir = path.join(fixtureDir, ".claude");
          const configDir = path.join(claudeDir, ".picc");
          fs.mkdirSync(configDir, { recursive: true });
          fs.writeFileSync(path.join(configDir, "config.json"), JSON.stringify({ proactiveCompactPercent: 90 }));
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
          { toolCalls: [{ name: "write", args: { path: "stop-transfer-b.txt", content: "complete-b" } }], usage: highUsage },
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

  it(
    "compacts after real permission-blocked and invalid tool calls while preserving the completed sibling",
    async () => {
      const highUsage = { prompt_tokens: 90_000, completion_tokens: 100, total_tokens: 90_100 };
      const result = await runPi({
        contextWindow: 100_000,
        piSettings: { compaction: { enabled: false, reserveTokens: 100, keepRecentTokens: 1 } },
        setup(fixtureDir) {
          const claudeDir = path.join(fixtureDir, ".claude");
          const configDir = path.join(claudeDir, ".picc");
          fs.mkdirSync(configDir, { recursive: true });
          fs.writeFileSync(path.join(configDir, "config.json"), JSON.stringify({ proactiveCompactPercent: 90 }));
          fs.writeFileSync(path.join(claudeDir, "settings.json"), JSON.stringify({ permissions: { deny: ["Write(blocked.txt)"] } }));
        },
        script: [
          { toolCalls: [
            { name: "write", args: { path: "fallback-sibling.txt", content: "completed sibling" } },
            { name: "write", args: { path: "blocked.txt", content: "must not land" } },
            { name: "not_a_registered_tool", args: { malformed: true } },
          ], usage: highUsage },
          { text: "FALLBACK_PERMISSION_INVALID_SUMMARY_T05" },
          { text: "FALLBACK_PERMISSION_INVALID_FINAL_T05" },
        ],
        prompt: "run fallback batch",
      });

      expect(result.code).toBe(0);
      expect(result.requests.map((request) => request.requestKind)).toEqual(["ordinary", "compaction", "ordinary"]);
      expect(fs.readFileSync(path.join(result.fixture, "fallback-sibling.txt"), "utf8")).toBe("completed sibling");
      expect(fs.existsSync(path.join(result.fixture, "blocked.txt"))).toBe(false);
      const summaryInput = allText(result.requests[1]!);
      expect(summaryInput).toContain("Successfully wrote");
      expect(summaryInput).toMatch(/blocked|denied/i);
      expect(summaryInput).toMatch(/not_a_registered_tool|not found|unknown/i);
      expect(result.stdout.match(/FALLBACK_PERMISSION_INVALID_FINAL_T05/g)).toHaveLength(1);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "fails a mixed real-Pi tool batch closed, persists completed siblings, then compacts and resumes once",
    async () => {
      const highUsage = { prompt_tokens: 90_000, completion_tokens: 100, total_tokens: 90_100 };
      const result = await runPi({
        contextWindow: 100_000,
        piSettings: { compaction: { enabled: false, reserveTokens: 100, keepRecentTokens: 1 } },
        setup(fixtureDir) {
          const configDir = path.join(fixtureDir, ".claude", ".picc");
          fs.mkdirSync(configDir, { recursive: true });
          fs.writeFileSync(path.join(configDir, "config.json"), JSON.stringify({ proactiveCompactPercent: 90 }));
        },
        script: [
          {
            toolCalls: [
              { name: "write", args: { path: "mixed-sibling.txt", content: "persisted-before-compact" } },
              { name: "Skill", args: { name: "missing-real-stack-skill" } },
            ],
            usage: highUsage,
          },
          { text: "MIXED_SUMMARY_T05" },
          { text: "MIXED_RESUMED_FINAL_T05" },
        ],
        prompt: "run the complete mixed batch",
      });

      expect(result.code).toBe(0);
      expect(fs.readFileSync(path.join(result.fixture, "mixed-sibling.txt"), "utf8")).toBe("persisted-before-compact");
      expect(result.requests.map((request) => `${request.sessionKind}/${request.requestKind}`)).toEqual([
        "main/ordinary",
        "main/compaction",
        "main/ordinary",
      ]);
      expect(result.stdout.match(/MIXED_RESUMED_FINAL_T05/g)).toHaveLength(1);
      expect(allText(result.requests[1]!)).toContain("missing-real-stack-skill");
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
      const user = userText(result.requests[0]!);
      expect(user).toContain("FS-SKILL-ARGS-BODY");
      expect(user).toContain("Deploy to environment **staging** at version **7.7**");
      // It expanded — the raw slash command is not what reached the model verbatim.
      expect(user).not.toMatch(/^\s*"?\/deploy staging 7\.7"?\s*$/);
    },
    TEST_TIMEOUT_MS,
  );
});

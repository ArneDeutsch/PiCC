import { execFileSync } from "node:child_process";
import fs from "node:fs";
import net, { type Socket } from "node:net";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
  BASH_AVAILABLE,
  CHECKPOINT_CONTEXT_WINDOW,
  CHECKPOINT_USAGE,
  cliMissing,
  createE2ELive,
  systemText,
  TEST_TIMEOUT_MS,
  toolNames,
  toolResultText,
  writeCheckpointConfig,
  CLI_PATH,
} from "./helpers/e2e-live.js";
import { deferred, waitUntil } from "./helpers/async.js";
import { createResponseGate, type CapturedRequest, type Turn } from "./helpers/mock-openai.js";
import { resolveSubagentTranscript } from "../src/util/subagent-transcripts.js";
import { RECORD_EXPAND_HINT, RECORD_FORK_MARKER } from "../src/runtime/subagent-render.js";

/**
 * E2E — subagents (the heaviest lane; each scenario spawns a nested Pi child):
 * background dispatch + TaskOutput, worktree isolation, provider-error named
 * failure, and on-disk transcript persistence. See test/helpers/e2e-live.ts.
 */

const { startPi, runPi, cleanup } = createE2ELive({ runtime: "compiled" });
afterEach(cleanup);

/** Canonicalize a path for cross-form comparison (backslashes, casing, trailing slash). */
function normPath(p: string): string {
  return path.resolve(p).replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

/** First capture group of `re` across any request's tool-result text, or undefined. */
function firstGroup(requests: CapturedRequest[], re: RegExp): string | undefined {
  for (const request of requests) {
    const m = re.exec(toolResultText(request));
    if (m?.[1] !== undefined) return m[1];
  }
  return undefined;
}

function requestedTool(request: CapturedRequest, name: string): boolean {
  return request.messages.some((message) => {
    if (message.role !== "assistant" || !Array.isArray(message.tool_calls)) return false;
    return message.tool_calls.some((call) => {
      if (typeof call !== "object" || call === null) return false;
      const fn = (call as Record<string, unknown>).function;
      return typeof fn === "object" && fn !== null && (fn as Record<string, unknown>).name === name;
    });
  });
}

type WireToolCall = { id: string; name: string; arguments: string };
type OrderedToolExchange = {
  call: WireToolCall;
  callIndex: number;
  result: string;
  resultIndex: number;
};

function assistantToolCalls(request: CapturedRequest, name: string): Array<WireToolCall & { messageIndex: number }> {
  const calls: Array<WireToolCall & { messageIndex: number }> = [];
  request.messages.forEach((message, messageIndex) => {
    if (message.role !== "assistant" || !Array.isArray(message.tool_calls)) return;
    for (const value of message.tool_calls) {
      if (typeof value !== "object" || value === null) continue;
      const call = value as Record<string, unknown>;
      const fn = call.function;
      if (typeof call.id !== "string" || typeof fn !== "object" || fn === null) continue;
      const wireFunction = fn as Record<string, unknown>;
      if (wireFunction.name !== name || typeof wireFunction.arguments !== "string") continue;
      calls.push({ id: call.id, name, arguments: wireFunction.arguments, messageIndex });
    }
  });
  return calls;
}

/** Deduplicate cumulative snapshots by provider call ID, not by result content. */
function uniqueAssistantToolCalls(requests: CapturedRequest[], name: string): WireToolCall[] {
  const byId = new Map<string, WireToolCall>();
  for (const request of requests.filter((candidate) => candidate.sessionKind === "main")) {
    for (const { messageIndex: _messageIndex, ...found } of assistantToolCalls(request, name)) {
      const prior = byId.get(found.id);
      if (prior !== undefined && JSON.stringify(prior) !== JSON.stringify(found)) {
        throw new Error(`Conflicting cumulative tool-call history for ${found.id}`);
      }
      byId.set(found.id, found);
    }
  }
  return [...byId.values()];
}

/** Match each call to exactly one later result inside one cumulative parent history. */
function orderedToolExchanges(request: CapturedRequest, name: string): OrderedToolExchange[] {
  const calls = assistantToolCalls(request, name);
  return calls.map(({ messageIndex: callIndex, ...call }) => {
    const results = request.messages.flatMap((message, resultIndex) =>
      message.role === "tool" && message.tool_call_id === call.id && typeof message.content === "string"
        ? [{ result: message.content, resultIndex }]
        : []
    );
    expect(results, `one model-visible result for ${call.id}`).toHaveLength(1);
    expect(results[0]!.resultIndex, `result for ${call.id} follows its assistant call`).toBeGreaterThan(callIndex);
    return { call, callIndex, ...results[0]! };
  });
}

function cumulativeParentHistory(requests: CapturedRequest[], callIds: string[]): CapturedRequest {
  let history: CapturedRequest | undefined;
  for (let index = requests.length - 1; index >= 0; index -= 1) {
    const request = requests[index]!;
    if (request.sessionKind !== "main") continue;
    const ids = new Set(request.messages.flatMap((message) =>
      message.role === "assistant" && Array.isArray(message.tool_calls)
        ? message.tool_calls.flatMap((value) =>
          typeof value === "object" && value !== null && typeof (value as Record<string, unknown>).id === "string"
            ? [(value as Record<string, unknown>).id as string]
            : [])
        : []));
    if (callIds.every((id) => ids.has(id)) && callIds.every((id) =>
      request.messages.some((message) => message.role === "tool" && message.tool_call_id === id))) {
      history = request;
      break;
    }
  }
  expect(history, "a cumulative parent request containing every call and matching result").toBeDefined();
  return history!;
}

const STRUCTURED_SUBAGENT_RESULT = `{
  "type": "function",
  "function": {
    "name": "TaskOutput",
    "arguments": {
      "task_id": "task-structured-canary",
      "wait": false
    }
  },
  "summary": "review complete",
  "findings": [],
  "recommendation": "approve"
}`;
function expectStructuredTaskOutputResult(result: string): void {
  expect(result.slice(0, STRUCTURED_SUBAGENT_RESULT.length)).toBe(STRUCTURED_SUBAGENT_RESULT);
  expect(result.slice(STRUCTURED_SUBAGENT_RESULT.length)).toMatch(
    /^\nusage: in \d+(?:\.\d+)? · out \d+(?:\.\d+)? · cache read \d+(?:\.\d+)? · cache write \d+(?:\.\d+)? · <?\$\d+(?:\.\d+)?$/u,
  );
}

describe.skipIf(cliMissing)(
  "e2e subagents: real Pi CLI + PiCC extension + mock OpenAI model",
  () => {
    if (cliMissing) {
      // eslint-disable-next-line no-console
      console.warn(
        `Skipping live e2e tests: Pi CLI not found at ${CLI_PATH} — run npm install first.`,
      );
    }

    it(
      "fails fast after one deterministic foreground-child compaction transaction",
      async () => {
        const child = (request: CapturedRequest) => request.sessionKind === "child";
        const parent = (request: CapturedRequest) => request.sessionKind === "main";
        const childErrorSentinels = ["CHILD_SUMMARY_SECRET_T05", "C:/private/child/session.jsonl", "CHILD_TRANSCRIPT_T05"];
        const result = await runPi({
          persistSession: true,
          classifier: {
            childUserMessages: ["finish all child reads"],
            childSystemMarkers: ["You are a read-only exploration agent"],
          },
          contextWindow: CHECKPOINT_CONTEXT_WINDOW,
          piSettings: { compaction: { enabled: true, reserveTokens: 100, keepRecentTokens: 1 } },
          setup(fixtureDir) {
            writeCheckpointConfig(fixtureDir);
            fs.writeFileSync(path.join(fixtureDir, "child-a.txt"), "a".repeat(24_000));
            fs.writeFileSync(path.join(fixtureDir, "child-b.txt"), "b".repeat(24_000));
            fs.writeFileSync(path.join(fixtureDir, "child-c.txt"), "c".repeat(24_000));
            fs.writeFileSync(path.join(fixtureDir, "child-d.txt"), "d".repeat(24_000));
          },
          script: [
            {
              toolCalls: [{
                name: "Agent",
                args: { subagent_type: "Explore", prompt: "finish all child reads", run_in_background: false },
              }],
            },
            {
              when: child,
              toolCalls: [
                { name: "read", args: { path: "child-a.txt" } },
                { name: "read", args: { path: "child-b.txt" } },
              ],
            },
            {
              when: child,
              toolCalls: [
                { name: "read", args: { path: "child-c.txt" } },
                { name: "read", args: { path: "child-d.txt" } },
              ],
              usage: CHECKPOINT_USAGE,
            },
            {
              when: (request) => child(request) && request.requestKind === "compaction",
              error: { status: 400, sticky: false, message: childErrorSentinels.join(" ") },
            },
            { when: parent, text: "PARENT_RECEIVED_CHILD_FAILURE_T05" },
          ],
          prompt: "run the foreground child",
          modeArgs: ["--mode", "json", "-p", "run the foreground child"],
        });

        expect(result.code).toBe(0);
        expect(result.requests.map((request) => `${request.sessionKind}/${request.requestKind}`)).toEqual([
          "main/ordinary",
          "child/ordinary",
          "child/ordinary",
          "child/compaction",
          "main/ordinary",
        ]);
        expect(fs.readFileSync(path.join(result.fixture, "child-a.txt"), "utf8")).toHaveLength(24_000);
        expect(fs.readFileSync(path.join(result.fixture, "child-b.txt"), "utf8")).toHaveLength(24_000);
        expect(fs.readFileSync(path.join(result.fixture, "child-c.txt"), "utf8")).toHaveLength(24_000);
        expect(fs.readFileSync(path.join(result.fixture, "child-d.txt"), "utf8")).toHaveLength(24_000);
        expect(toolResultText(result.requests[4]!)).toContain("paused and no continuation ran");
        const childSessionFiles: string[] = [];
        const walkSessions = (dir: string) => {
          for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) walkSessions(full);
            else if (entry.name.endsWith(".jsonl") && full.includes(".subagents")) childSessionFiles.push(full);
          }
        };
        walkSessions(path.join(result.agentDir, "sessions"));
        expect(childSessionFiles).toHaveLength(1);
        const childEntries = SessionManager.open(childSessionFiles[0]!).getEntries();
        const childCompactions = childEntries.filter((entry) => entry.type === "compaction");
        expect(childCompactions).toHaveLength(0);
        const visible = `${result.stdout}\n${result.stderr}\n${JSON.stringify(childEntries)}`;
        for (const sentinel of childErrorSentinels) expect(visible).not.toContain(sentinel);
        const jsonEvents = result.stdout.trim().split(/\r?\n/u).map((line) => JSON.parse(line) as any);
        const terminalParentMessages = jsonEvents.filter((event) =>
          event.type === "message_end" && event.message?.role === "assistant" &&
          JSON.stringify(event.message.content).includes("PARENT_RECEIVED_CHILD_FAILURE_T05"));
        expect(terminalParentMessages).toHaveLength(1);
      },
      TEST_TIMEOUT_MS,
    );

    it(
      "joins an active resumed child stop and preserves its canonical retained report",
      async () => {
        const child = (request: CapturedRequest) => request.sessionKind === "child";
        const parent = (request: CapturedRequest) => request.sessionKind === "main";
        const resumedGate = createResponseGate();
        const parentControlGate = createResponseGate();
        const agentIdOutputTurn: Turn = {
          when(request) {
            const locator = /TaskOutput with task_id "(agent-[0-9a-f]{12})"/u.exec(toolResultText(request));
            if (!locator) return false;
            agentIdOutputTurn.toolCalls = [{ name: "TaskOutput", args: { task_id: locator[1]! } }];
            return true;
          },
        };
        let fixtureDir = "";
        const stopObserverConnected = deferred<Socket>();
        let stopObserverSocket: Socket | undefined;
        const stopObserverServer = net.createServer((socket) => {
          stopObserverSocket = socket;
          stopObserverConnected.resolve(socket);
        });
        await new Promise<void>((resolve, reject) => {
          stopObserverServer.once("error", reject);
          stopObserverServer.listen(0, "127.0.0.1", resolve);
        });
        const stopObserverAddress = stopObserverServer.address();
        if (!stopObserverAddress || typeof stopObserverAddress === "string") throw new Error("TaskStop observer did not bind TCP");
        const stopObserverPort = stopObserverAddress.port;
        const resultPromise = runPiWithActiveStop();

        async function runPiWithActiveStop() {
          const started = await startPi({
            persistSession: true,
            classifier: {
              childUserMessages: ["commit and resume the cancellation witness"],
              childSystemMarkers: ["You are a general-purpose agent"],
            },
            contextWindow: CHECKPOINT_CONTEXT_WINDOW,
            piSettings: { compaction: { enabled: true, reserveTokens: 100, keepRecentTokens: 1 } },
            setup(dir) {
              fixtureDir = dir;
              writeCheckpointConfig(dir);
              const extensionsDir = path.join(dir, ".pi", "extensions");
              fs.mkdirSync(extensionsDir, { recursive: true });
              for (const name of ["a", "b", "c", "d"]) {
                fs.writeFileSync(path.join(dir, `active-stop-${name}.txt`), name.repeat(24_000));
              }
              fs.writeFileSync(path.join(extensionsDir, "observe-task-stop.ts"), [
                'import fs from "node:fs";',
                'import net from "node:net";',
                'import path from "node:path";',
                'import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";',
                "export default function observeTaskStop(pi: ExtensionAPI) {",
                '  const marker = (name: string) => fs.writeFileSync(path.join(process.cwd(), name), "1\\n");',
                `  pi.on("tool_call", async (event) => { if (event.toolName === "TaskStop") { marker("task-stop-started.txt"); await new Promise<void>((resolve, reject) => { const socket = net.connect(${stopObserverPort}, "127.0.0.1"); socket.once("end", resolve); socket.once("error", reject); }); } });`,
                '  pi.on("tool_result", (event) => { if (event.toolName === "TaskStop") marker("task-stop-settled.txt"); });',
                "}",
              ].join("\n"));
            },
            script: [
              {
                when: parent,
                toolCalls: [{ name: "Agent", args: {
                  subagent_type: "general-purpose",
                  prompt: "commit and resume the cancellation witness",
                  run_in_background: true,
                } }],
              },
              {
                when: child,
                toolCalls: [
                  { name: "write", args: { path: "subagent-stop-effect.txt", content: "one-effect" } },
                  { name: "read", args: { path: "active-stop-a.txt" } },
                  { name: "read", args: { path: "active-stop-b.txt" } },
                ],
              },
              {
                when: child,
                toolCalls: [
                  { name: "read", args: { path: "active-stop-c.txt" } },
                  { name: "read", args: { path: "active-stop-d.txt" } },
                ],
                usage: CHECKPOINT_USAGE,
              },
              {
                when: (request) => child(request) && request.requestKind === "compaction",
                text: "ACTIVE_STOP_CHILD_SUMMARY",
              },
              {
                when: (request) => child(request) && request.requestKind === "ordinary",
                text: "ACTIVE_STOP_RESUMED_MUST_NOT_COMPLETE",
                gate: resumedGate,
              },
              {
                when: parent,
                toolCalls: [{ name: "SendMessage", args: {
                  to: "general-purpose",
                  message: "retained before stop",
                } }],
                gate: parentControlGate,
              },
              {
                when: parent,
                toolCalls: [
                  { name: "TaskStop", args: { task_id: "task-1" } },
                  { name: "SendMessage", args: {
                    to: "general-purpose",
                    message: "must be refused during stop",
                  } },
                ],
              },
              { when: parent, toolCalls: [{ name: "TaskOutput", args: { task_id: "task-1", wait: false } }] },
              { when: parent, toolCalls: [{ name: "TaskOutput", args: { task_id: "task-1" } }] },
              agentIdOutputTurn,
              { when: parent, text: "active child stop verified" },
            ],
            prompt: "exercise active resumed child cancellation",
          });

          const resumed = await Promise.race([
            resumedGate.entered.then(() => undefined, async () => {
              const early = await started.completion;
              throw new Error(`Pi exited before resumed gate: ${JSON.stringify(early.requests.map((request) => `${request.sessionKind}/${request.requestKind}`))}\n${early.stderr}`);
            }),
            started.completion.then((early) => {
              throw new Error(`Pi exited before resumed gate: ${JSON.stringify(early.requests.map((request) => `${request.sessionKind}/${request.requestKind}`))}\n${early.stderr}`);
            }),
          ]);
          void resumed;
          await parentControlGate.entered;
          const stopStarted = path.join(fixtureDir, "task-stop-started.txt");
          const stopSettled = path.join(fixtureDir, "task-stop-settled.txt");
          const stopStartedWait = waitUntil({
            description: "TaskStop tool call to start",
            predicate: () => fs.existsSync(stopStarted),
            describeObserved: () => `started=${fs.existsSync(stopStarted)}, settled=${fs.existsSync(stopSettled)}`,
          });
          parentControlGate.release();
          await stopStartedWait;
          const observerSocket = await stopObserverConnected.promise;
          expect(fs.existsSync(stopSettled), "TaskStop must publish an in-progress interval").toBe(false);
          observerSocket.end();
          await waitUntil({
            description: "TaskStop tool result to settle",
            predicate: () => fs.existsSync(stopSettled),
            describeObserved: () => `started=${fs.existsSync(stopStarted)}, settled=${fs.existsSync(stopSettled)}`,
          });
          resumedGate.release();
          return started.completion;
        }

        const result = await resultPromise.finally(async () => {
          stopObserverSocket?.destroy();
          await new Promise<void>((resolve) => stopObserverServer.close(() => resolve()));
        });
        expect(result.code, result.stderr).toBe(0);
        expect(fs.readFileSync(path.join(result.fixture, "subagent-stop-effect.txt"), "utf8")).toBe("one-effect");
        expect(result.requests.filter(child).map((request) => request.requestKind)).toEqual([
          "ordinary", "ordinary", "compaction", "ordinary",
        ]);
        expect(result.requests.filter(child).every((request) => request.authorizationValid)).toBe(true);
        const childWriteIds = new Set(result.requests.filter(child).flatMap((request) =>
          assistantToolCalls(request, "write").map((call) => call.id)));
        expect(childWriteIds.size).toBe(1);
        expect(result.requests.filter(child).some((request) =>
          JSON.stringify(request.body).includes("must be refused during stop"))).toBe(false);

        const sendCalls = uniqueAssistantToolCalls(result.requests, "SendMessage");
        const stopCalls = uniqueAssistantToolCalls(result.requests, "TaskStop");
        const outputCalls = uniqueAssistantToolCalls(result.requests, "TaskOutput");
        expect(sendCalls).toHaveLength(2);
        expect(stopCalls).toHaveLength(1);
        expect(outputCalls).toHaveLength(3);
        const allCallIds = [...sendCalls, ...stopCalls, ...outputCalls].map((call) => call.id);
        const history = cumulativeParentHistory(result.requests, allCallIds);
        const sendExchanges = orderedToolExchanges(history, "SendMessage");
        const accepted = sendExchanges.find((exchange) =>
          JSON.parse(exchange.call.arguments).message === "retained before stop");
        const refused = sendExchanges.find((exchange) =>
          JSON.parse(exchange.call.arguments).message === "must be refused during stop");
        expect(accepted?.result).toMatch(/delivered to running agent/iu);
        expect(refused?.result).toMatch(/settling cancellation; the message was not sent/iu);

        const stopExchange = orderedToolExchanges(history, "TaskStop")[0]!;
        expect(stopExchange.call.id).toBe(stopCalls[0]!.id);
        expect(JSON.parse(stopExchange.call.arguments)).toEqual({ task_id: "task-1" });
        expect(stopExchange.result).toMatch(/stop confirmed after settlement at stage resumed-cancellation/iu);
        expect(stopExchange.result).toMatch(/1 retained input occurrence\(s\)/iu);
        const locatorMatch = /TaskOutput with task_id "(agent-[0-9a-f]{12})"/u.exec(stopExchange.result);
        expect(locatorMatch, "TaskStop must advertise the stable agent-ID locator").not.toBeNull();
        const agentId = locatorMatch![1]!;
        const locator = `TaskOutput with task_id "${agentId}"`;
        expect(stopExchange.result).toContain(locator);
        expect(stopExchange.result).not.toContain("Retained input report for");
        expect(stopExchange.result).not.toContain("retained before stop");

        const outputExchanges = orderedToolExchanges(history, "TaskOutput");
        expect(outputExchanges.map((exchange) => JSON.parse(exchange.call.arguments))).toEqual([
          { task_id: "task-1", wait: false },
          { task_id: "task-1" },
          { task_id: agentId },
        ]);
        const outputs = outputExchanges.map((exchange) => exchange.result);
        const reportHeader = `Retained input report for ${agentId}: 1 represented, 0 unrepresentable (1 total); stage resumed-cancellation; 1 retained input occurrence(s).`;
        const canonicalReports = outputs.map((output) => output.slice(output.indexOf(reportHeader)));
        for (const report of canonicalReports) {
          expect(report).toContain(reportHeader);
          expect(report).toContain(`Locator: ${locator}.`);
          expect(report).toContain("Reported input was not auto-replayed. Inspect possible existing files, tools, and external effects before any deliberate retry.");
          expect(report).toContain('1. steer: "retained before stop"');
          expect(report).toContain("No retained input was replayed automatically.");
        }
        expect(outputs[1]).toBe(outputs[0]);
        expect(canonicalReports[1]).toBe(canonicalReports[0]);
        expect(canonicalReports[2]).toBe(canonicalReports[0]);

        const mainSessionFiles: string[] = [];
        const collectMainSessions = (directory: string): void => {
          for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
            const full = path.join(directory, entry.name);
            if (entry.isDirectory()) collectMainSessions(full);
            else if (entry.name.endsWith(".jsonl") && !full.includes(".subagents")) mainSessionFiles.push(full);
          }
        };
        collectMainSessions(path.join(result.agentDir, "sessions"));
        expect(mainSessionFiles).toHaveLength(1);
        const childTranscript = resolveSubagentTranscript(mainSessionFiles[0]!, agentId);
        expect(childTranscript, "advertised agent ID must resolve to the originating child transcript").toBeDefined();
        const childTranscriptText = fs.readFileSync(childTranscript!, "utf8");
        const childEntries = SessionManager.open(childTranscript!).getEntries();
        const abortedTerminalResults = childEntries.filter((entry) =>
          JSON.stringify(entry).includes("ACTIVE_STOP_RESUMED_MUST_NOT_COMPLETE"));
        expect(abortedTerminalResults).toHaveLength(0);
        const terminalSurfaces = [
          childTranscriptText,
          result.stdout,
          result.stderr,
          JSON.stringify(history.messages),
        ].join("\n");
        expect(terminalSurfaces).not.toContain("ACTIVE_STOP_RESUMED_MUST_NOT_COMPLETE");
        expect(result.stdout).toContain("active child stop verified");
      },
      TEST_TIMEOUT_MS,
    );

    it(
      "resolves an explicit child model synchronously with eager parent/child tools and no stored-credential leak",
      async () => {
        const defaultCredentialCanary = "synthetic-default-credential-canary-e2e";
        const childCredentialCanary = "synthetic-child-credential-canary-e2e";
        const credentialCanaries = [defaultCredentialCanary, childCredentialCanary];
        const childProvider = "mock-child";
        const childModel = "mock-2";
        const isParent = (request: CapturedRequest) => request.model === "mock-1";
        const isChild = (request: CapturedRequest) => request.model === childModel;
        const result = await runPi({
          persistSession: true,
          defaultModelCredential: defaultCredentialCanary,
          secondaryModel: {
            provider: childProvider,
            id: childModel,
            credential: childCredentialCanary,
          },
          script: [
            {
              when: isParent,
              toolCalls: [
                {
                  name: "Agent",
                  args: {
                    subagent_type: "general-purpose",
                    prompt: "verify the explicit model boundary",
                    model: `${childProvider}/${childModel}`,
                    run_in_background: false,
                  },
                },
              ],
            },
            { when: isChild, text: "EXPLICIT-CHILD-MODEL-DONE" },
            { when: isParent, text: "explicit child model verified" },
          ],
          prompt: "dispatch on the explicit child model",
        });

        expect(result.code).toBe(0);
        const parentFirst = result.requests.find(isParent);
        const childFirst = result.requests.find(isChild);
        expect(parentFirst, "the default model must receive the parent's first request").toBeDefined();
        expect(childFirst, "the explicit model must receive the child's first request").toBeDefined();

        const eagerParentTools = [
          "read", "write", "edit", "bash", "grep", "find", "ls", "Grep", "Glob", "MultiEdit", "WebFetch", "WebSearch",
          "Agent", "Task", "SendMessage", "Skill", "SlashCommand",
          "EnterWorktree", "ExitWorktree", "TaskCreate", "TaskUpdate",
          "TaskList", "TaskGet", "TodoWrite", "TaskOutput", "TaskStop",
          "NotebookRead", "NotebookEdit", "AskUserQuestion", "ExitPlanMode",
          "EnterPlanMode", "Artifact", "computer", "LSP", "BashOutput",
          "KillShell", "KillBash",
        ];
        const eagerChildTools = eagerParentTools.filter(
          (name) => !["Agent", "Task", "SendMessage"].includes(name),
        );
        expect(new Set(toolNames(parentFirst!))).toEqual(new Set(eagerParentTools));
        expect(new Set(toolNames(childFirst!))).toEqual(new Set(eagerChildTools));

        const trailerRe = /\[agent (agent-[0-9a-f]{12}) completed — resumable via SendMessage\]/;
        const withTrailer = result.requests.find((request) => trailerRe.test(toolResultText(request)));
        expect(withTrailer, "parent must receive the explicit-model child's agent-ID trailer").toBeDefined();
        const trailerText = toolResultText(withTrailer!);
        expect(trailerText).toContain("EXPLICIT-CHILD-MODEL-DONE");
        const agentId = trailerRe.exec(trailerText)![1]!;

        const sessionsRoot = path.join(result.agentDir, "sessions");
        const mainFiles: string[] = [];
        const transcriptText: string[] = [];
        const collectTranscripts = (dir: string): void => {
          for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) collectTranscripts(full);
            else if (entry.name.endsWith(".jsonl")) {
              transcriptText.push(fs.readFileSync(full, "utf8"));
              if (!dir.endsWith(".subagents")) mainFiles.push(full);
            }
          }
        };
        collectTranscripts(sessionsRoot);
        expect(mainFiles).toHaveLength(1);
        const resolved = resolveSubagentTranscript(mainFiles[0]!, agentId);
        expect(resolved, "resolver must map the delivered agent ID to the child transcript").toBeDefined();
        expect(fs.readFileSync(resolved!, "utf8")).toContain("EXPLICIT-CHILD-MODEL-DONE");
        const reopened = SessionManager.open(resolved!);
        expect(reopened.getSessionId()).toBe(agentId);
        const restored = JSON.stringify(reopened.buildSessionContext().messages);
        expect(restored).toContain("verify the explicit model boundary");
        expect(restored).toContain("EXPLICIT-CHILD-MODEL-DONE");

        const persistedTranscripts = transcriptText.join("\n");
        for (const credentialCanary of credentialCanaries) {
          expect(result.stdout).not.toContain(credentialCanary);
          expect(result.stderr).not.toContain(credentialCanary);
          expect(persistedTranscripts).not.toContain(credentialCanary);
          for (const request of result.requests) {
            expect(request.authorizationValid).toBe(true);
            expect(toolResultText(request)).not.toContain(credentialCanary);
            expect(JSON.stringify(request.body)).not.toContain(credentialCanary);
          }
        }
      },
      TEST_TIMEOUT_MS,
    );

    // --- Scenario: run_in_background + TaskOutput retrieval ---
    it(
      "retrieves structured background output, rejects malformed TaskOutput, and continues safely",
      async () => {
        // Child completion and the parent's continuation can reach the mock
        // concurrently, so route by real request shape rather than script order.
        const isExplore = (r: CapturedRequest) =>
          systemText(r).includes("read-only exploration agent");
        const isParent = (r: CapturedRequest) => !isExplore(r);
        const malformedArguments = {
          summary: "review complete",
          findings: [],
          recommendation: "approve",
        };
        const result = await runPi({
          script: [
            {
              toolCalls: [{
                name: "Agent",
                args: {
                  subagent_type: "Explore",
                  prompt: "return the structured review result before the malformed contrast",
                  run_in_background: true,
                },
              }],
            },
            { when: isExplore, text: STRUCTURED_SUBAGENT_RESULT },
            { when: isParent, toolCalls: [{ name: "TaskOutput", args: { task_id: "task-1" } }] },
            { when: isParent, toolCalls: [{ name: "TaskOutput", args: malformedArguments }] },
            { when: isParent, text: "malformed call rejected" },
          ],
          prompt: "exercise the explicit malformed-call contrast",
        });

        expect(result.code).toBe(0);
        const startResult = result.requests.find((request) =>
          /Background task task-\d+ accepted/.test(toolResultText(request)),
        );
        expect(startResult, "expected the immediate background-acceptance tool result").toBeDefined();
        const calls = uniqueAssistantToolCalls(result.requests, "TaskOutput");
        expect(calls).toHaveLength(2);
        const valid = calls.find((call) => "task_id" in (JSON.parse(call.arguments) as Record<string, unknown>));
        const malformed = calls.find((call) => !("task_id" in (JSON.parse(call.arguments) as Record<string, unknown>)));
        expect(valid).toBeDefined();
        expect(malformed).toBeDefined();
        expect(valid!.id).not.toBe(malformed!.id);
        expect(JSON.parse(valid!.arguments)).toEqual({ task_id: "task-1" });
        expect(JSON.parse(malformed!.arguments)).toEqual(malformedArguments);

        const parentHistory = cumulativeParentHistory(result.requests, [valid!.id, malformed!.id]);
        const exchanges = orderedToolExchanges(parentHistory, "TaskOutput");
        expect(exchanges).toHaveLength(2);
        const validExchange = exchanges.find((exchange) => exchange.call.id === valid!.id)!;
        const malformedExchange = exchanges.find((exchange) => exchange.call.id === malformed!.id)!;
        expect(validExchange.callIndex).toBeLessThan(validExchange.resultIndex);
        expect(validExchange.resultIndex).toBeLessThan(malformedExchange.callIndex);
        expect(malformedExchange.callIndex).toBeLessThan(malformedExchange.resultIndex);
        expectStructuredTaskOutputResult(validExchange.result);
        expect(malformedExchange.result).toContain('Validation failed for tool "TaskOutput"');
        expect(malformedExchange.result).toMatch(/(?:task_id.*(?:required|missing)|(?:required|missing).*task_id)/is);
        expect(malformedExchange.result).not.toMatch(/Unknown task_id|task-structured-canary/);
        // The validation result is model-visible in parentHistory; stdout proves safe continuation.
        expect(result.stdout).toContain("malformed call rejected");
        expect(result.stdout).not.toContain(RECORD_EXPAND_HINT);
        expect(result.stdout).not.toContain(RECORD_FORK_MARKER);
        expect(result.stderr).not.toMatch(/UnhandledPromiseRejection|unhandledRejection|FATAL/i);
      },
      TEST_TIMEOUT_MS,
    );

    // --- Scenario: completed coordinator EnterWorktree routes a later ordinary child dispatch ---
    it.skipIf(!BASH_AVAILABLE)(
      "keeps an ordinary foreground subagent's relative writes in the coordinator worktree",
      async () => {
        const worktreeName = "coordinator-child-cwd";
        const writeEditRelative = "child-write-edit.txt";
        const bashRelative = "child-bash.txt";
        const isChild = (r: CapturedRequest) =>
          systemText(r).includes("You are a general-purpose agent");
        const isParent = (r: CapturedRequest) => !isChild(r);

        const result = await runPi({
          fixture: "full-surface",
          script: [
            {
              when: isParent,
              toolCalls: [{ name: "EnterWorktree", args: { name: worktreeName } }],
            },
            {
              when: isParent,
              toolCalls: [
                {
                  name: "Agent",
                  args: {
                    subagent_type: "general-purpose",
                    prompt: "perform the requested relative file operations",
                    run_in_background: false,
                  },
                },
              ],
            },
            {
              when: isChild,
              toolCalls: [
                {
                  name: "write",
                  args: {
                    path: writeEditRelative,
                    content: "WRITE-CANARY\nEDIT-BEFORE\n",
                  },
                },
              ],
            },
            {
              when: isChild,
              toolCalls: [
                {
                  name: "edit",
                  args: {
                    path: writeEditRelative,
                    oldText: "EDIT-BEFORE",
                    newText: "EDIT-AFTER",
                  },
                },
              ],
            },
            {
              when: isChild,
              toolCalls: [
                {
                  name: "bash",
                  args: { command: `printf '%s\\n' 'BASH-CANARY' > ${bashRelative}` },
                },
              ],
            },
            { when: isChild, text: "COORDINATOR-CWD-CHILD-DONE" },
            { when: isParent, text: "coordinator worktree dispatch verified" },
          ],
          prompt: "enter a worktree, then delegate relative writes",
        });

        expect(result.code).toBe(0);

        const childRequests = result.requests.filter(isChild);
        const parentRequests = result.requests.filter(isParent);
        const enterCompletion = parentRequests.find((request) => {
          const text = toolResultText(request).replaceAll("\\", "/");
          return text.includes("Created and entered worktree:") &&
            text.includes(`/.claude/worktrees/${worktreeName}`);
        });
        expect(enterCompletion, "EnterWorktree must complete before Agent dispatch").toBeDefined();
        for (const toolName of ["write", "edit", "bash"]) {
          expect(
            childRequests.some((request) => requestedTool(request, toolName)),
            `the child session must issue ${toolName}`,
          ).toBe(true);
          expect(
            parentRequests.some((request) => requestedTool(request, toolName)),
            `the coordinator must not issue ${toolName}`,
          ).toBe(false);
        }

        const agentCompletion = parentRequests.find((request) =>
          toolResultText(request).includes("COORDINATOR-CWD-CHILD-DONE"),
        );
        expect(agentCompletion, "the foreground Agent call must return the child completion").toBeDefined();
        expect(toolResultText(agentCompletion!), "the Agent result must not be failed partial output")
          .not.toContain("[subagent cut off]");
        expect(result.stdout).toContain("coordinator worktree dispatch verified");

        const worktreeDir = path.join(result.fixture, ".claude", "worktrees", worktreeName);
        const writeEditInWorktree = path.join(worktreeDir, writeEditRelative);
        const bashInWorktree = path.join(worktreeDir, bashRelative);
        expect(fs.readFileSync(writeEditInWorktree, "utf8")).toBe("WRITE-CANARY\nEDIT-AFTER\n");
        expect(fs.readFileSync(bashInWorktree, "utf8")).toBe("BASH-CANARY\n");
        expect(fs.existsSync(path.join(result.fixture, writeEditRelative))).toBe(false);
        expect(fs.existsSync(path.join(result.fixture, bashRelative))).toBe(false);
      },
      TEST_TIMEOUT_MS,
    );

    // --- Frontmatter worktree isolation, write placement, and Bash environment ---
    it.skipIf(!BASH_AVAILABLE)(
      "keeps an isolated worker's writes and real Bash environment inside its frontmatter worktree",
      async () => {
        const result = await runPi({
          fixture: "full-surface",
          script: [
            // 0) orchestrator dispatches the worktree-isolated agent synchronously
            //    (pin run_in_background: false — this scenario tests worktree
            //    isolation, foreground is incidental).
            {
              toolCalls: [
                {
                  name: "Agent",
                  args: {
                    subagent_type: "isolated-worker",
                    prompt: "create out.txt with the canary",
                    run_in_background: false,
                  },
                },
              ],
            },
            // 1) the subagent (own session, cwd = its worktree) writes the file
            { toolCalls: [{ name: "write", args: { path: "out.txt", content: "ISO-WT-CONTENT" } }] },
            // 2) the same isolated child crosses the real model → Bash boundary.
            {
              toolCalls: [{
                name: "bash",
                args: {
                  command: 'echo "FSVAR=[$FS_FIXTURE]"; echo "PROJDIR=[$CLAUDE_PROJECT_DIR]"; echo "CWD=[$(pwd)]"',
                },
              }],
            },
            // 3) the subagent's final answer
            { text: "DONE-ISO" },
            // 4) orchestrator's follow-up
            { text: "isolation verified" },
          ],
          prompt: "have isolated-worker create out.txt",
        });

        expect(result.code).toBe(0);
        // The file exists inside the agent's worktree...
        const worktreesRoot = path.join(result.fixture, ".claude", "worktrees");
        const isoDirs = fs.existsSync(worktreesRoot)
          ? fs.readdirSync(worktreesRoot).filter((n) => n.startsWith("agent-isolated-worker-"))
          : [];
        expect(isoDirs.length, `expected an agent-isolated-worker-* worktree under ${worktreesRoot}`).toBeGreaterThanOrEqual(1);
        const outInWorktree = isoDirs
          .map((n) => path.join(worktreesRoot, n, "out.txt"))
          .filter((p) => fs.existsSync(p));
        expect(outInWorktree.length, "out.txt must exist in the isolated-worker worktree").toBeGreaterThanOrEqual(1);
        expect(fs.readFileSync(outInWorktree[0]!, "utf8")).toBe("ISO-WT-CONTENT");
        // ...and NOT at the fixture root (isolation held).
        expect(fs.existsSync(path.join(result.fixture, "out.txt"))).toBe(false);

        // The worktree is registered with git (kept after the dispatch).
        const worktreeList = execFileSync("git", ["-C", result.fixture, "worktree", "list"], {
          encoding: "utf8",
        });
        expect(worktreeList).toContain("agent-isolated-worker-");

        const bashResult = result.requests
          .map((request) => toolResultText(request))
          .find((text) => /FSVAR=\[full-surface\]/.test(text));
        expect(bashResult, "parent history must retain the isolated Bash result").toBeDefined();
        expect(bashResult).toMatch(/CWD=\[[^\]]+\]/);
        expect(bashResult).toMatch(/PROJDIR=\[[^\]]+\]/);
        expect(bashResult).not.toMatch(/\b\d+ (?:output |command )?lines? hidden\b/iu);
        expect(bashResult).not.toMatch(/\bto expand\b/iu);
        const bashCwd = firstGroup(result.requests, /CWD=\[([^\]]*)\]/);
        expect(bashCwd, "subagent Bash must report its worktree cwd").toBeDefined();
        expect(bashCwd!.replace(/\\/g, "/")).toContain("worktrees");
        // Claude's project variable intentionally remains the main checkout even
        // while the isolated child's real Bash process runs in its own worktree.
        const projectDir = firstGroup(result.requests, /PROJDIR=\[([^\]]*)\]/);
        expect(projectDir, "subagent Bash must receive CLAUDE_PROJECT_DIR").toBeDefined();
        expect(normPath(projectDir!)).toBe(normPath(result.fixture));
        expect(projectDir!.replace(/\\/g, "/")).not.toContain("worktrees");

        // The subagent's final message came back to the orchestrator verbatim.
        const done = result.requests.some((r) => toolResultText(r).includes("DONE-ISO"));
        expect(done, "parent tool result must contain DONE-ISO").toBe(true);
      },
      TEST_TIMEOUT_MS,
    );

    // --- Scenario: mid-run EnterWorktree — builtins and the deny guard follow the new cwd ---
    // A non-isolation subagent enters a worktree AS A TOOL CALL mid-run, then its
    // relative-path write and bash pwd act in the NEW worktree while CLAUDE_PROJECT_DIR
    // stays the project root. A deny rule scoped to a path inside that worktree is
    // enforced by the guard against the same (worktree) cwd the built-in write uses —
    // proving guard/built-in cwd agreement across the real Pi stack.
    it.skipIf(!BASH_AVAILABLE)(
      "keeps a subagent's built-ins and deny guard in lockstep with a worktree it enters mid-run",
      async () => {
        const worktreeName = "midrun-net"; // deterministic → .claude/worktrees/midrun-net
        const result = await runPi({
          fixture: "full-surface",
          script: [
            // 0) orchestrator dispatches the non-isolation worktree-runner (foreground)
            {
              toolCalls: [
                {
                  name: "Agent",
                  args: {
                    subagent_type: "midrun-worktree-runner",
                    prompt: "enter a worktree and work inside it",
                    run_in_background: false,
                  },
                },
              ],
            },
            // 1) the subagent enters a fresh worktree by a deterministic name
            { toolCalls: [{ name: "EnterWorktree", args: { name: worktreeName } }] },
            // 2) bash pwd + project dir, evaluated from inside the new worktree
            {
              toolCalls: [
                {
                  name: "bash",
                  args: { command: 'echo "CWD=[$(pwd)]"; echo "PROJDIR=[$CLAUDE_PROJECT_DIR]"' },
                },
              ],
            },
            // 3) an allowed relative-path write lands in the new worktree
            { toolCalls: [{ name: "write", args: { path: "landed.txt", content: "MIDRUN-LANDED" } }] },
            // 4) a write to the worktree-scoped denied path — the guard must block it
            {
              toolCalls: [{ name: "write", args: { path: "no-write.txt", content: "SHOULD-NOT-LAND" } }],
            },
            // 5) the subagent's final answer
            { text: "MIDRUN-DONE" },
            // 6) orchestrator's follow-up
            { text: "midrun verified" },
          ],
          prompt: "have midrun-worktree-runner enter a worktree and work inside it",
        });

        expect(result.code).toBe(0);

        const worktreeDir = path.join(result.fixture, ".claude", "worktrees", worktreeName);

        // The allowed relative write landed INSIDE the mid-run worktree, not the main tree.
        const landed = path.join(worktreeDir, "landed.txt");
        expect(fs.existsSync(landed), `landed.txt must exist in ${worktreeDir}`).toBe(true);
        expect(fs.readFileSync(landed, "utf8")).toContain("MIDRUN-LANDED");
        expect(fs.existsSync(path.join(result.fixture, "landed.txt"))).toBe(false);

        // bash pwd ran inside the new worktree, and CLAUDE_PROJECT_DIR still points
        // at the project root — not the worktree the subagent just entered.
        const cwdSeen = result.requests.some((r) =>
          /CWD=\[[^\]]*midrun-net[^\]]*\]/.test(toolResultText(r)),
        );
        expect(cwdSeen, "subagent bash pwd must run inside the mid-run worktree").toBe(true);
        const projDir = firstGroup(result.requests, /PROJDIR=\[([^\]]*)\]/);
        expect(projDir, "subagent bash must see CLAUDE_PROJECT_DIR inside the worktree").toBeDefined();
        expect(normPath(projDir!)).toBe(normPath(result.fixture));
        expect(projDir!.replace(/\\/g, "/")).not.toContain("worktrees");

        // Guard/built-in agreement. The built-in-follows-cwd half is pinned by the
        // `landed.txt` assertion above (pre-fix it would have landed at the construction
        // root, not the worktree). This deny assertion pins the complementary direction:
        // a worktree-scoped deny is enforced against the same live cwd, so a guarded write
        // never lands (catches a guard-at-root / built-in-at-worktree bypass).
        expect(fs.existsSync(path.join(worktreeDir, "no-write.txt"))).toBe(false);
        const denied = result.requests.find(
          (r) => /deny|blocked/i.test(toolResultText(r)) && toolResultText(r).includes("no-write.txt"),
        );
        expect(denied, "the worktree-scoped Write deny must be enforced against the subagent cwd").toBeDefined();

        // The subagent's final message came back to the orchestrator verbatim.
        expect(result.requests.some((r) => toolResultText(r).includes("MIDRUN-DONE"))).toBe(true);
      },
      TEST_TIMEOUT_MS,
    );

    // --- Scenario: a subagent dying on a terminal API error surfaces as a NAMED failure ---
    it(
      "reports a subagent killed by a sticky API error as a named failure — never an empty success",
      async () => {
        // The child (Explore) session is identified by its read-only persona;
        // every one of ITS requests — including any Pi auto-retries — hits the
        // same sticky 429. The insufficient_quota message is non-retryable for
        // Pi (pi-ai utils/retry.js), mirroring the drained-limit incident that
        // motivated this suite, so the child dies on its first request.
        const isExplore = (r: CapturedRequest) =>
          systemText(r).includes("read-only exploration agent");
        const isParent = (r: CapturedRequest) => !isExplore(r);
        const providerSecret = "PROVIDER_SECRET_SENTINEL_T05";
        const providerPath = "C:/private/provider/session.jsonl";
        const providerTranscript = "TRANSCRIPT_SENTINEL_T05";
        const result = await runPi({
          script: [
            // 0) parent dispatches the Explore subagent synchronously (first request
            //    is the parent). Pin run_in_background: false — this scenario
            //    tests the inline named-failure surface, foreground is incidental.
            {
              when: isParent,
              toolCalls: [
                {
                  name: "Agent",
                  args: {
                    subagent_type: "Explore",
                    prompt: "look around",
                    run_in_background: false,
                  },
                },
              ],
            },
            // sticky terminal error for the child session (never consumed)
            {
              when: isExplore,
              error: {
                status: 429,
                message: `insufficient_quota: mock usage limit drained (E2E-API-DEATH) ${"safe-filler-".repeat(60)} ${providerSecret} ${providerPath} ${providerTranscript}`,
              },
            },
            // parent's follow-up once the failed tool result is in
            { when: isParent, text: "saw the failure" },
          ],
          prompt: "explore the project (the subagent is doomed)",
        });

        expect(result.code).toBe(0);
        // The parent's follow-up request carries a tool result NAMING the API error.
        const failed = result.requests.find((r) =>
          toolResultText(r).includes("Agent terminated early due to an API error"),
        );
        expect(failed, "parent must receive the named API failure as a tool result").toBeDefined();
        expect(toolResultText(failed!)).toContain("E2E-API-DEATH");
        expect(result.stdout).toContain("saw the failure");
        // No crash noise from the failed dispatch.
        expect(result.stderr).not.toMatch(/UnhandledPromiseRejection|unhandledRejection|FATAL/i);
        const everyVisibleSurface = [result.stdout, result.stderr,
          ...result.requests.map((request) => toolResultText(request))].join("\n");
        for (const sentinel of [providerSecret, providerPath, providerTranscript]) {
          expect(everyVisibleSurface).not.toContain(sentinel);
        }
      },
      TEST_TIMEOUT_MS,
    );
  },
);

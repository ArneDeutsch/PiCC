import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionManager, type SessionEntry } from "@earendil-works/pi-coding-agent";
import {
  CHECKPOINT_CONTEXT_WINDOW,
  CHECKPOINT_PI_SETTINGS,
  CHECKPOINT_USAGE,
  CLI_PATH,
  cliMissing,
  createE2ELive,
  findSessionFiles,
  readJsonLines,
  type JsonLineObject,
  TEST_TIMEOUT_MS,
  toolResultText,
  writeCheckpointConfig,
} from "./helpers/e2e-live.js";
import type { CapturedRequest, Turn } from "./helpers/mock-openai.js";

const { runPi, cleanup } = createE2ELive({ runtime: "compiled" });
afterEach(cleanup);

const MAIN_RETRY_SETTINGS = {
  ...CHECKPOINT_PI_SETTINGS,
  retry: { enabled: true, maxRetries: 1, baseDelayMs: 1, provider: { maxRetries: 0, maxRetryDelayMs: 1 } },
};

interface CommandHook {
  type: "command";
  command: string;
}

interface HookMatcher {
  matcher: string;
  hooks: CommandHook[];
}

interface FixtureSettings {
  hooks?: Record<string, HookMatcher[]>;
  [key: string]: unknown;
}

function installCompactHooks(fixtureDir: string): void {
  writeCheckpointConfig(fixtureDir);
  const settingsPath = path.join(fixtureDir, ".claude", "settings.json");
  const parsed: unknown = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Fixture settings must be an object");
  }
  const settings = parsed as FixtureSettings;
  const hooks = settings.hooks ?? {};
  hooks.PreCompact = [{
    matcher: "auto",
    hooks: [{ type: "command", command: "echo PreCompact >> \"$CLAUDE_PROJECT_DIR/compact-hooks.txt\"" }],
  }];
  hooks.SessionStart = [{
    matcher: "compact",
    hooks: [{ type: "command", command: "echo SessionStartCompact >> \"$CLAUDE_PROJECT_DIR/compact-hooks.txt\"" }],
  }];
  hooks.PostCompact = [{
    matcher: "auto",
    hooks: [{ type: "command", command: "echo PostCompact >> \"$CLAUDE_PROJECT_DIR/compact-hooks.txt\"" }],
  }];
  settings.hooks = hooks;
  fs.writeFileSync(settingsPath, JSON.stringify(settings));

  const extensionsDir = path.join(fixtureDir, ".pi", "extensions");
  fs.mkdirSync(extensionsDir, { recursive: true });
  fs.writeFileSync(path.join(extensionsDir, "compaction-lifecycle.ts"), [
    'import fs from "node:fs";',
    'import path from "node:path";',
    'import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";',
    "export default function compactionLifecycle(pi: ExtensionAPI) {",
    '  const trace = path.join(process.cwd(), "physical-compaction.txt");',
    '  pi.on("session_before_compact", () => fs.appendFileSync(trace, "start\\n"));',
    '  pi.on("session_compact", () => fs.appendFileSync(trace, "commit\\n"));',
    "}",
  ].join("\n"));
}

function fixtureTrace(fixture: string, name: string): string[] {
  const trace = path.join(fixture, name);
  return fs.existsSync(trace)
    ? fs.readFileSync(trace, "utf8").trim().split(/\r?\n/u).filter(Boolean)
    : [];
}

interface PiccLifecycleRecord extends JsonLineObject {
  type: "entry_appended";
  entry: {
    customType: "picc-checkpoint-lifecycle";
    data: {
      category: string;
      notice?: string;
      action?: string;
      recovery?: string;
      stage?: string;
      restoredCount?: number;
      reportedCount?: number;
      unresolvedCount?: number;
      nonTextCount?: number;
    };
  };
}

function objectValue(value: unknown): JsonLineObject | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonLineObject
    : undefined;
}

function piCCLifecycle(records: JsonLineObject[]): PiccLifecycleRecord[] {
  return records.filter((record): record is PiccLifecycleRecord => {
    const entry = objectValue(record.entry);
    const data = objectValue(entry?.data);
    return record.type === "entry_appended" && entry?.customType === "picc-checkpoint-lifecycle" &&
      typeof data?.category === "string" &&
      (data.notice === undefined || typeof data.notice === "string") &&
      (data.action === undefined || typeof data.action === "string") &&
      (data.recovery === undefined || typeof data.recovery === "string");
  });
}

function piCCOwnedJsonRecords(records: JsonLineObject[]): JsonLineObject[] {
  return records.filter((record) => {
    const entry = objectValue(record.entry);
    const message = objectValue(record.message);
    const entryOwned = record.type === "entry_appended" &&
      typeof entry?.customType === "string" && entry.customType.startsWith("picc-");
    const customMessageOwned = typeof message?.customType === "string" && message.customType.startsWith("picc-");
    const agentResultOwned = message?.role === "toolResult" && message.toolName === "Agent";
    // Native compaction/error events are intentionally excluded: extensions do not own their diagnostics.
    return entryOwned || customMessageOwned || agentResultOwned;
  });
}

function occurrences(value: unknown, needle: string): number {
  return JSON.stringify(value).split(needle).length - 1;
}

function expectPrivateSentinelAbsentFromJson(records: JsonLineObject[], sentinel: string): void {
  const owned = piCCOwnedJsonRecords(records);
  expect(owned.length).toBeGreaterThan(0);
  expect(JSON.stringify(owned)).not.toContain(sentinel);
}

function requestsAfterFirstSummary(requests: CapturedRequest[]): CapturedRequest[] {
  const failedSummaryIndex = requests.findIndex((request) => request.requestKind === "compaction");
  expect(failedSummaryIndex).toBeGreaterThanOrEqual(0);
  return requests.slice(failedSummaryIndex + 1);
}

function postFailureOrdinaryRequests(requests: CapturedRequest[]): CapturedRequest[] {
  return requestsAfterFirstSummary(requests).filter((request) => request.requestKind === "ordinary");
}

function expectPersistedContinuation(
  entries: readonly SessionEntry[],
  customType: string,
  content: string,
): void {
  const continuations = entries.filter((entry) =>
    entry.type === "custom_message" && entry.customType === customType);
  expect(continuations).toHaveLength(1);
  expect(continuations[0]).toMatchObject({ content });
}

function installOneShotResumedCancellation(fixtureDir: string): void {
  writeCheckpointConfig(fixtureDir);
  const extensionsDir = path.join(fixtureDir, ".pi", "extensions");
  fs.mkdirSync(extensionsDir, { recursive: true });
  fs.writeFileSync(path.join(extensionsDir, "cancel-first-resumed-assistant.ts"), [
    'import fs from "node:fs";',
    'import path from "node:path";',
    'import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";',
    "export default function cancelFirstResumedAssistant(pi: ExtensionAPI) {",
    "  let committed = false;",
    "  let cancelled = false;",
    '  const counter = path.join(process.cwd(), "resumed-cancellation-count.txt");',
    '  pi.on("session_compact", () => { committed = true; });',
    '  pi.on("message_start", (event, ctx) => {',
    '    if (!committed || cancelled || event.message.role !== "assistant") return;',
    "    cancelled = true;",
    '    fs.writeFileSync(counter, "1\\n");',
    "    ctx.abort();",
    "  });",
    "}",
  ].join("\n"));
}

describe.skipIf(cliMissing)("e2e compaction retries through the real Pi stack", () => {
  if (cliMissing) {
    // eslint-disable-next-line no-console
    console.warn(`Skipping live e2e tests: Pi CLI not found at ${CLI_PATH} — run npm install first.`);
  }

  it("recovers one main summary transport failure inside one physical compaction", async () => {
    const sentinel = "MAIN_RETRY_PRIVATE_DIAGNOSTIC C:/private/main-retry/session.jsonl";
    const result = await runPi({
      persistSession: true,
      modeArgs: ["--mode", "json", "-p", "run main retry checkpoint"],
      prompt: "unused",
      contextWindow: CHECKPOINT_CONTEXT_WINDOW,
      piSettings: MAIN_RETRY_SETTINGS,
      setup: installCompactHooks,
      script: [
        { toolCalls: [{ name: "write", args: { path: "main-retry.txt", content: "complete" } }], usage: CHECKPOINT_USAGE },
        { when: (request) => request.requestKind === "compaction", error: { status: 503, sticky: false, message: sentinel } },
        { when: (request) => request.requestKind === "compaction", text: "MAIN_RETRY_SUMMARY" },
        { text: "MAIN_RETRY_RESUMED" },
      ],
    });

    expect(result.code, result.stderr).toBe(0);
    expect(result.requests.map((request) => `${request.sessionKind}/${request.requestKind}`)).toEqual([
      "main/ordinary", "main/compaction", "main/compaction", "main/ordinary",
    ]);
    const records = readJsonLines(result.stdout);
    expect(records.filter((record) => record.type === "compaction_start")).toHaveLength(1);
    expect(records.filter((record) => record.type === "compaction_end")).toHaveLength(1);
    const lifecycle = piCCLifecycle(records);
    expect(lifecycle.map((record) => record.entry.data.category)).toEqual([
      "checkpoint-armed", "checkpoint-complete", "checkpoint-resumed",
    ]);
    expectPrivateSentinelAbsentFromJson(records, sentinel);
    expect(fixtureTrace(result.fixture, "physical-compaction.txt")).toEqual(["start", "commit"]);
    expect(fixtureTrace(result.fixture, "compact-hooks.txt")).toEqual([
      "PreCompact", "SessionStartCompact", "PostCompact",
    ]);
    expect(records.filter((record) => record.type === "message_end" &&
      JSON.stringify(record.message).includes("MAIN_RETRY_RESUMED"))).toHaveLength(1);

    const requestsAfterFailure = requestsAfterFirstSummary(result.requests);
    expect(requestsAfterFailure.every((request) => !JSON.stringify(request.body).includes(sentinel))).toBe(true);
    const resumedOrdinary = postFailureOrdinaryRequests(result.requests);
    expect(resumedOrdinary).toHaveLength(1);
    expect(occurrences(resumedOrdinary[0]!.body, "Continue the paused work.")).toBe(1);

    const allSessionFiles = findSessionFiles(result.agentDir);
    const sessionFiles = allSessionFiles.filter((file) => !file.includes(".subagents"));
    expect(sessionFiles).toHaveLength(1);
    const entries = SessionManager.open(sessionFiles[0]!).getEntries();
    const compactEntries = entries.filter((entry) => entry.type === "compaction");
    expect(compactEntries).toHaveLength(1);
    expect(occurrences(compactEntries, "MAIN_RETRY_SUMMARY")).toBe(1);
    expectPersistedContinuation(entries, "picc-checkpoint-continuation", "Continue the paused work.");
    expect(occurrences(entries, "MAIN_RETRY_RESUMED")).toBe(1);
    for (const file of allSessionFiles) expect(fs.readFileSync(file, "utf8")).not.toContain(sentinel);
  }, TEST_TIMEOUT_MS);

  it("exhausts exactly the configured main summary budget and remains safely paused", async () => {
    const sentinel = "MAIN_EXHAUST_PRIVATE_DIAGNOSTIC C:/private/main-exhaust/session.jsonl";
    const failure: Turn = {
      when: (request) => request.requestKind === "compaction",
      error: { status: 503, message: sentinel },
    };
    const result = await runPi({
      persistSession: true,
      modeArgs: ["--mode", "json", "-p", "run main exhausted retry checkpoint"],
      prompt: "unused",
      contextWindow: CHECKPOINT_CONTEXT_WINDOW,
      piSettings: MAIN_RETRY_SETTINGS,
      setup: installCompactHooks,
      script: [
        { toolCalls: [{ name: "write", args: { path: "main-exhaust.txt", content: "retained" } }], usage: CHECKPOINT_USAGE },
        failure,
        { text: "ORDINARY_MUST_NOT_RUN_AFTER_RETRY_EXHAUSTION" },
      ],
    });

    // A non-interactive caller has to tell "finished" from "gave up" without reading
    // prose, and a partial answer on stdout with status 0 is what a CI wrapper consumes
    // as success. Outside the TUI, a checkpoint that ends paused sets status 3 —
    // deliberately not 0, and not the 1 Pi's own print-mode failures use. The finished
    // side of the same contract is the status 0 asserted by the recovering scenario above.
    expect(result.code, result.stderr).toBe(3);
    expect(result.requests.map((request) => request.requestKind)).toEqual([
      "ordinary", "compaction", "compaction",
    ]);
    const records = readJsonLines(result.stdout);
    expect(records.filter((record) => record.type === "compaction_start")).toHaveLength(1);
    expect(records.filter((record) => record.type === "compaction_end")).toHaveLength(1);
    const lifecycle = piCCLifecycle(records);
    expect(lifecycle.map((record) => record.entry.data.category)).toEqual([
      "checkpoint-armed", "checkpoint-exhausted",
    ]);
    expectPrivateSentinelAbsentFromJson(records, sentinel);
    expect(fixtureTrace(result.fixture, "physical-compaction.txt")).toEqual(["start"]);
    expect(fixtureTrace(result.fixture, "compact-hooks.txt")).toEqual(["PreCompact"]);
    const requestsAfterFailure = requestsAfterFirstSummary(result.requests);
    expect(requestsAfterFailure.every((request) => !JSON.stringify(request.body).includes(sentinel))).toBe(true);
    expect(postFailureOrdinaryRequests(result.requests)).toHaveLength(0);
    expect(`${result.stdout}\n${result.stderr}`).not.toContain("ORDINARY_MUST_NOT_RUN_AFTER_RETRY_EXHAUSTION");
    expect(lifecycle.at(-1)?.entry).toMatchObject({
      data: {
        action: "manual-recovery",
        recovery: "/compact, then explicitly continue",
      },
    });
    expect(lifecycle.at(-1)?.entry.data.notice).toContain("Run /compact, then explicitly continue");
    expect(fs.readFileSync(path.join(result.fixture, "main-exhaust.txt"), "utf8")).toBe("retained");

    const allSessionFiles = findSessionFiles(result.agentDir);
    const sessionFiles = allSessionFiles.filter((file) => !file.includes(".subagents"));
    expect(sessionFiles).toHaveLength(1);
    const entries = SessionManager.open(sessionFiles[0]!).getEntries();
    const compactEntries = entries.filter((entry) => entry.type === "compaction");
    expect(compactEntries).toHaveLength(0);
    const initiatingTurns = entries.filter((entry) => entry.type === "message" &&
      entry.message.role === "user" &&
      occurrences(entry.message.content, "run main exhausted retry checkpoint") === 1);
    expect(initiatingTurns).toHaveLength(1);
    const writeCalls = entries.filter((entry) => entry.type === "message" &&
      entry.message.role === "assistant" && occurrences(entry.message, '"name":"write"') === 1 &&
      occurrences(entry.message, "main-exhaust.txt") === 1);
    expect(writeCalls).toHaveLength(1);
    const writeResults = entries.filter((entry) => entry.type === "message" &&
      entry.message.role === "toolResult" && entry.message.toolName === "write" &&
      entry.message.isError === false && occurrences(entry.message, "Successfully wrote") === 1 &&
      occurrences(entry.message, "main-exhaust.txt") === 1);
    expect(writeResults).toHaveLength(1);
    for (const file of allSessionFiles) expect(fs.readFileSync(file, "utf8")).not.toContain(sentinel);
  }, TEST_TIMEOUT_MS);

  it("reports a post-commit resumed cancellation as a non-reusable one-shot partial outcome", async () => {
    const result = await runPi({
      persistSession: true,
      modeArgs: ["--mode", "json", "-p", "run one-shot resumed cancellation"],
      prompt: "unused",
      contextWindow: CHECKPOINT_CONTEXT_WINDOW,
      piSettings: CHECKPOINT_PI_SETTINGS,
      setup: installOneShotResumedCancellation,
      script: [
        { toolCalls: [{ name: "write", args: { path: "one-shot-before-cancel.txt", content: "existing-effect" } }], usage: CHECKPOINT_USAGE },
        { when: (request) => request.requestKind === "compaction", text: "ONE_SHOT_CANCEL_SUMMARY" },
        { text: "ONE_SHOT_RESUMED_MUST_ABORT" },
      ],
    });

    expect(result.code, result.stderr).toBe(3);
    expect(result.requests.map((request) => request.requestKind)).toEqual([
      "ordinary", "compaction", "ordinary",
    ]);
    expect(fs.readFileSync(path.join(result.fixture, "resumed-cancellation-count.txt"), "utf8")).toBe("1\n");
    expect(fs.readFileSync(path.join(result.fixture, "one-shot-before-cancel.txt"), "utf8")).toBe("existing-effect");

    const records = readJsonLines(result.stdout);
    const lifecycle = piCCLifecycle(records);
    expect(lifecycle.map((record) => record.entry.data.category)).toEqual([
      "checkpoint-armed", "checkpoint-complete", "checkpoint-resumed", "checkpoint-cancelled",
    ]);
    const cancellation = lifecycle.at(-1)!.entry.data;
    expect(cancellation).toMatchObject({
      action: "retrieve-and-relaunch",
      stage: "resumed-cancellation",
      restoredCount: 0,
      reportedCount: 0,
      unresolvedCount: 0,
      nonTextCount: 0,
    });
    expect(cancellation.notice).toMatch(/client\/request history/iu);
    expect(cancellation.notice).toMatch(/deliberate resubmission/iu);
    expect(cancellation.notice).toMatch(/files, tools, or external effects/iu);
    expect(cancellation.notice).toMatch(/fresh request\/session/iu);
    expect(cancellation.notice).not.toMatch(/same-session|session-reusable/iu);
    expect(lifecycle.some((record) => record.entry.data.action === "session-reusable")).toBe(false);
    expect(records.filter((record) => record.type === "message_end" &&
      JSON.stringify(record.message).includes("ONE_SHOT_RESUMED_MUST_ABORT"))).toHaveLength(1);
  }, TEST_TIMEOUT_MS);

  it("recovers one child summary transport failure with production in-memory retry defaults", async () => {
    const child = (request: CapturedRequest) => request.sessionKind === "child";
    const parent = (request: CapturedRequest) => request.sessionKind === "main";
    const sentinel = "CHILD_RETRY_PRIVATE_DIAGNOSTIC C:/private/child-retry/session.jsonl";
    const result = await runPi({
      persistSession: true,
      modeArgs: ["--mode", "json", "-p", "run child retry checkpoint"],
      prompt: "unused",
      classifier: {
        childUserMessages: ["finish child retry reads"],
        childSystemMarkers: ["You are a read-only exploration agent"],
      },
      contextWindow: CHECKPOINT_CONTEXT_WINDOW,
      piSettings: { compaction: { enabled: true, reserveTokens: 100, keepRecentTokens: 1 } },
      setup(fixtureDir) {
        installCompactHooks(fixtureDir);
        for (const [name, value] of [["a", "a"], ["b", "b"], ["c", "c"], ["d", "d"]] as const) {
          fs.writeFileSync(path.join(fixtureDir, `child-retry-${name}.txt`), value.repeat(24_000));
        }
      },
      script: [
        { when: parent, toolCalls: [{ name: "Agent", args: {
          subagent_type: "Explore", prompt: "finish child retry reads", run_in_background: false,
        } }] },
        { when: child, toolCalls: [
          { name: "read", args: { path: "child-retry-a.txt" } },
          { name: "read", args: { path: "child-retry-b.txt" } },
        ] },
        { when: child, toolCalls: [
          { name: "read", args: { path: "child-retry-c.txt" } },
          { name: "read", args: { path: "child-retry-d.txt" } },
        ], usage: CHECKPOINT_USAGE },
        { when: (request) => child(request) && request.requestKind === "compaction", error: {
          status: 503, sticky: false, message: sentinel,
        } },
        { when: (request) => child(request) && request.requestKind === "compaction", text: "CHILD_RETRY_SUMMARY" },
        { when: child, text: "CHILD_RETRY_RESUMED" },
        { when: parent, text: "PARENT_RECEIVED_CHILD_RETRY" },
      ],
    });

    expect(result.code, result.stderr).toBe(0);
    expect(result.requests.map((request) => `${request.sessionKind}/${request.requestKind}`)).toEqual([
      "main/ordinary", "child/ordinary", "child/ordinary", "child/compaction",
      "child/compaction", "child/ordinary", "main/ordinary",
    ]);
    expect(fixtureTrace(result.fixture, "physical-compaction.txt")).toEqual(["start", "start", "commit"]);
    expect(fixtureTrace(result.fixture, "compact-hooks.txt")).toEqual([
      "PreCompact", "PreCompact", "SessionStartCompact", "PostCompact",
    ]);
    expect(toolResultText(result.requests.at(-1)!)).toContain("CHILD_RETRY_RESUMED");
    expect(toolResultText(result.requests.at(-1)!).match(/CHILD_RETRY_RESUMED/g)).toHaveLength(1);

    const requestsAfterFailure = requestsAfterFirstSummary(result.requests);
    expect(requestsAfterFailure.every((request) => !JSON.stringify(request.body).includes(sentinel))).toBe(true);
    const ordinaryAfterFailure = postFailureOrdinaryRequests(result.requests);
    expect(ordinaryAfterFailure).toHaveLength(2);
    const childResumedRequests = ordinaryAfterFailure.filter((request) => request.sessionKind === "child");
    expect(childResumedRequests).toHaveLength(1);
    const childResumeContent = "Context was compacted. Continue the same pending task from the preserved state.";
    expect(occurrences(childResumedRequests[0]!.body, childResumeContent)).toBe(1);

    const allSessionFiles = findSessionFiles(result.agentDir);
    const childFiles = allSessionFiles.filter((file) => file.includes(".subagents"));
    const parentFiles = allSessionFiles.filter((file) => !file.includes(".subagents"));
    expect(childFiles).toHaveLength(1);
    expect(parentFiles).toHaveLength(1);
    const entries = SessionManager.open(childFiles[0]!).getEntries();
    const compactEntries = entries.filter((entry) => entry.type === "compaction");
    expect(compactEntries).toHaveLength(1);
    expect(occurrences(compactEntries, "CHILD_RETRY_SUMMARY")).toBe(1);
    expectPersistedContinuation(entries, "picc-checkpoint-resume", childResumeContent);
    expect(occurrences(entries, "CHILD_RETRY_RESUMED")).toBe(1);
    for (const file of allSessionFiles) expect(fs.readFileSync(file, "utf8")).not.toContain(sentinel);
    const parentEntries = SessionManager.open(parentFiles[0]!).getEntries();
    expect(JSON.stringify(parentEntries)).not.toContain(sentinel);
    const records = readJsonLines(result.stdout);
    expectPrivateSentinelAbsentFromJson(records, sentinel);
    expect(toolResultText(result.requests.at(-1)!)).not.toContain(sentinel);
    expect(records.filter((record) => record.type === "message_end" &&
      JSON.stringify(record.message).includes("PARENT_RECEIVED_CHILD_RETRY"))).toHaveLength(1);
  }, TEST_TIMEOUT_MS);
});

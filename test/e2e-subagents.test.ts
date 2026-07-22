import { execFileSync } from "node:child_process";
import fs from "node:fs";
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
import type { CapturedRequest } from "./helpers/mock-openai.js";
import { resolveSubagentTranscript } from "../src/util/subagent-transcripts.js";
import { RECORD_EXPAND_HINT, RECORD_FORK_MARKER } from "../src/runtime/subagent-render.js";

/**
 * E2E — subagents (the heaviest lane; each scenario spawns a nested Pi child):
 * background dispatch + TaskOutput, worktree isolation, provider-error named
 * failure, and on-disk transcript persistence. See test/helpers/e2e-live.ts.
 */

const { runPi, cleanup } = createE2ELive();
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
      "retries and commits one real foreground-child compaction before returning one parent result",
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
            { when: (request) => child(request) && request.requestKind === "compaction", text: "CHILD_SUMMARY_T05" },
            { when: child, text: "CHILD_RESUMED_FINAL_T05" },
            { when: parent, text: "PARENT_RECEIVED_CHILD_T05" },
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
          "child/compaction",
          "child/ordinary",
          "main/ordinary",
        ]);
        expect(fs.readFileSync(path.join(result.fixture, "child-a.txt"), "utf8")).toHaveLength(24_000);
        expect(fs.readFileSync(path.join(result.fixture, "child-b.txt"), "utf8")).toHaveLength(24_000);
        expect(fs.readFileSync(path.join(result.fixture, "child-c.txt"), "utf8")).toHaveLength(24_000);
        expect(fs.readFileSync(path.join(result.fixture, "child-d.txt"), "utf8")).toHaveLength(24_000);
        expect(toolResultText(result.requests[6]!)).toContain("CHILD_RESUMED_FINAL_T05");
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
        expect(childCompactions).toHaveLength(1);
        expect((childCompactions[0] as { summary: string }).summary).toContain("CHILD_SUMMARY_T05");
        const visible = `${result.stdout}\n${result.stderr}\n${JSON.stringify(childEntries)}`;
        for (const sentinel of childErrorSentinels) expect(visible).not.toContain(sentinel);
        const jsonEvents = result.stdout.trim().split(/\r?\n/u).map((line) => JSON.parse(line) as any);
        const terminalParentMessages = jsonEvents.filter((event) =>
          event.type === "message_end" && event.message?.role === "assistant" &&
          JSON.stringify(event.message.content).includes("PARENT_RECEIVED_CHILD_T05"));
        expect(terminalParentMessages).toHaveLength(1);
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

        const transcriptText: string[] = [];
        const collectTranscripts = (dir: string) => {
          for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) collectTranscripts(full);
            else if (entry.name.endsWith(".jsonl")) transcriptText.push(fs.readFileSync(full, "utf8"));
          }
        };
        collectTranscripts(path.join(result.agentDir, "sessions"));
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
      "runs a background subagent and retrieves its verbatim result via TaskOutput",
      async () => {
        // The background dispatch's session and the parent's next turn hit the
        // mock CONCURRENTLY (order nondeterministic), so the subagent/parent
        // turns are pinned with `when` predicates instead of sequence position.
        // Explore is used because its persona is trivially detectable.
        const isExplore = (r: CapturedRequest) =>
          systemText(r).includes("read-only exploration agent");
        const isParent = (r: CapturedRequest) => !isExplore(r);
        const result = await runPi({
          script: [
            // 0) parent starts the background task (first request is always the parent)
            {
              toolCalls: [
                {
                  name: "Agent",
                  args: {
                    subagent_type: "Explore",
                    prompt: "look around",
                    run_in_background: true,
                  },
                },
              ],
            },
            // background subagent's single immediate final answer
            { when: isExplore, text: "BG-TASK-ANSWER-E2E" },
            // parent's next turn: retrieve the result (first background task id is task-1)
            { when: isParent, toolCalls: [{ name: "TaskOutput", args: { task_id: "task-1" } }] },
            // parent's final turn
            { when: isParent, text: "background retrieved" },
          ],
          prompt: "explore in the background",
        });

        expect(result.code).toBe(0);
        // The Agent call returned immediately with a task id.
        const startResult = result.requests.find((r) =>
          /Background task task-\d+ started/.test(toolResultText(r)),
        );
        expect(startResult, "expected the immediate background-start tool result").toBeDefined();
        // TaskOutput returned the subagent's final message verbatim as its tool result.
        const retrieved = result.requests.some((r) =>
          toolResultText(r).includes("BG-TASK-ANSWER-E2E"),
        );
        expect(retrieved, "TaskOutput must return the background result verbatim").toBe(true);
        expect(result.stdout).toContain("background retrieved");
        // Print mode never runs renderers: the TUI-only collapsed-completion-
        // record markers must never reach print stdout (byte-identical print/RPC
        // output — the structural half of that proof is that execute()/content
        // are untouched).
        expect(result.stdout).not.toContain(RECORD_EXPAND_HINT);
        expect(result.stdout).not.toContain(RECORD_FORK_MARKER);
        // No crash noise from the un-awaited dispatch (completeness floor).
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

    // --- Scenario 13 (E2E-4): subagent with isolation: worktree writes only in ITS worktree ---
    it.skipIf(!BASH_AVAILABLE)(
      "dispatches the iso-writer agent into its own worktree and keeps the main tree clean",
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
                    subagent_type: "iso-writer",
                    prompt: "create out.txt with the canary",
                    run_in_background: false,
                  },
                },
              ],
            },
            // 1) the subagent (own session, cwd = its worktree) writes the file
            { toolCalls: [{ name: "write", args: { path: "out.txt", content: "ISO-WT-CONTENT" } }] },
            // 2) the subagent's final answer
            { text: "DONE-ISO" },
            // 3) orchestrator's follow-up
            { text: "isolation verified" },
          ],
          prompt: "have iso-writer create out.txt",
        });

        expect(result.code).toBe(0);
        // The file exists inside the agent's worktree...
        const worktreesRoot = path.join(result.fixture, ".claude", "worktrees");
        const isoDirs = fs.existsSync(worktreesRoot)
          ? fs.readdirSync(worktreesRoot).filter((n) => n.startsWith("agent-iso-writer-"))
          : [];
        expect(isoDirs.length, `expected an agent-iso-writer-* worktree under ${worktreesRoot}`).toBeGreaterThanOrEqual(1);
        const outInWorktree = isoDirs
          .map((n) => path.join(worktreesRoot, n, "out.txt"))
          .filter((p) => fs.existsSync(p));
        expect(outInWorktree.length, "out.txt must exist in the iso-writer worktree").toBeGreaterThanOrEqual(1);
        expect(fs.readFileSync(outInWorktree[0]!, "utf8")).toBe("ISO-WT-CONTENT");
        // ...and NOT at the fixture root (isolation held).
        expect(fs.existsSync(path.join(result.fixture, "out.txt"))).toBe(false);

        // The worktree is registered with git (kept after the dispatch).
        const worktreeList = execFileSync("git", ["-C", result.fixture, "worktree", "list"], {
          encoding: "utf8",
        });
        expect(worktreeList).toContain("agent-iso-writer-");

        // The subagent's final message came back to the orchestrator verbatim.
        const done = result.requests.some((r) => toolResultText(r).includes("DONE-ISO"));
        expect(done, "parent tool result must contain DONE-ISO").toBe(true);
      },
      TEST_TIMEOUT_MS,
    );

    // --- Scenario: worktree-isolated subagent bash sees settings.env + CLAUDE_PROJECT_DIR ---
    // Proves the REAL shared bash factory honors its spawn env hook inside a real
    // subagent subprocess: a settings.env value reaches the subagent shell, and the
    // built-in CLAUDE_PROJECT_DIR points at the MAIN checkout — not the agent's own
    // isolation worktree (the parity semantic).
    it.skipIf(!BASH_AVAILABLE)(
      "delivers settings.env and CLAUDE_PROJECT_DIR (the project root, not the worktree) to a worktree-isolated subagent's bash",
      async () => {
        const result = await runPi({
          fixture: "full-surface",
          script: [
            // 0) orchestrator dispatches the worktree-isolated agent (foreground)
            {
              toolCalls: [
                {
                  name: "Agent",
                  args: {
                    subagent_type: "isolated-worker",
                    prompt: "print the project env",
                    run_in_background: false,
                  },
                },
              ],
            },
            // 1) the subagent echoes the settings.env var and the built-in project dir
            {
              toolCalls: [
                {
                  name: "bash",
                  args: {
                    command:
                      'echo "FSVAR=[$FS_FIXTURE]"; echo "PROJDIR=[$CLAUDE_PROJECT_DIR]"; echo "CWD=[$(pwd)]"',
                  },
                },
              ],
            },
            // 2) the subagent's final answer
            { text: "ENV-PROBE-DONE" },
            // 3) orchestrator's follow-up
            { text: "env verified" },
          ],
          prompt: "have isolated-worker print the project env",
        });

        expect(result.code).toBe(0);

        // settings.env (FS_FIXTURE) reached the subagent shell.
        const fsVarSeen = result.requests.some((r) =>
          /FSVAR=\[full-surface\]/.test(toolResultText(r)),
        );
        expect(fsVarSeen, "subagent bash must see settings.env FS_FIXTURE").toBe(true);

        // Self-containment: the discriminator below (PROJDIR==root, not the worktree)
        // only bites if the agent's bash really runs in a worktree. Assert cwd != root
        // so a silent isolation degrade can't make PROJDIR==root pass vacuously.
        const bashCwd = firstGroup(result.requests, /CWD=\[([^\]]*)\]/);
        expect(bashCwd, "subagent bash must report its cwd").toBeDefined();
        expect(bashCwd!.replace(/\\/g, "/")).toContain("worktrees");

        // CLAUDE_PROJECT_DIR reached the subagent shell and points at the main
        // checkout, NOT the agent's isolation worktree.
        const projDir = firstGroup(result.requests, /PROJDIR=\[([^\]]*)\]/);
        expect(projDir, "subagent bash must see CLAUDE_PROJECT_DIR").toBeDefined();
        expect(normPath(projDir!)).toBe(normPath(result.fixture));
        expect(projDir!.replace(/\\/g, "/")).not.toContain("worktrees");

        // The subagent's final message came back to the orchestrator verbatim.
        expect(result.requests.some((r) => toolResultText(r).includes("ENV-PROBE-DONE"))).toBe(true);
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

    // --- Scenario: persisted subagent transcript + model-visible agent ID (real stack) ---
    it(
      "persists the subagent transcript next to the main session and delivers the agent ID trailer to the parent",
      async () => {
        // The child is the general-purpose builtin — its PERSONA body appears
        // only in the child's system prompt (the parent catalog carries just
        // the description).
        const isChild = (r: CapturedRequest) =>
          systemText(r).includes("You are a general-purpose agent");
        const isParent = (r: CapturedRequest) => !isChild(r);
        const result = await runPi({
          persistSession: true, // NOT --no-session: the main session file must exist
          script: [
            {
              when: isParent,
              toolCalls: [
                {
                  name: "Agent",
                  args: {
                    subagent_type: "general-purpose",
                    prompt: "summarize the project",
                    // Pin run_in_background: false — this scenario tests the
                    // inline agent-ID trailer delivery, foreground is incidental.
                    run_in_background: false,
                  },
                },
              ],
            },
            { when: isChild, text: "SUBAGENT-TRANSCRIPT-CANARY: summary done" },
            { when: isParent, text: "delegated fine" },
          ],
          prompt: "delegate a summary to a general-purpose agent",
        });

        expect(result.code).toBe(0);

        // 1) The parent MODEL received the delimited agent-ID trailer in the
        //    tool result content (details would never reach it).
        const trailerRe = /\[agent (agent-[0-9a-f]{12}) completed — resumable via SendMessage\]/;
        const withTrailer = result.requests.find((r) => trailerRe.test(toolResultText(r)));
        expect(withTrailer, "parent must receive the agent-ID trailer").toBeDefined();
        const trailerText = toolResultText(withTrailer!);
        expect(trailerText).toContain("SUBAGENT-TRANSCRIPT-CANARY: summary done");
        const agentId = trailerRe.exec(trailerText)![1]!;

        // 2) The subagent transcript exists in the <mainBase>.subagents sibling
        //    directory of the REAL main session transcript, written by the REAL
        //    Pi AgentSession, and the exported resolver maps the ID to it.
        const sessionsRoot = path.join(result.agentDir, "sessions");
        const mainFiles: string[] = [];
        const walk = (dir: string) => {
          for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) walk(full);
            else if (entry.name.endsWith(".jsonl") && !dir.endsWith(".subagents")) {
              mainFiles.push(full);
            }
          }
        };
        walk(sessionsRoot);
        expect(mainFiles.length, `expected a main session transcript under ${sessionsRoot}`).toBeGreaterThanOrEqual(1);
        const resolved = mainFiles
          .map((main) => resolveSubagentTranscript(main, agentId))
          .find((p): p is string => p !== undefined);
        expect(resolved, "resolver must locate the subagent transcript from the main session").toBeDefined();
        expect(fs.readFileSync(resolved!, "utf8")).toContain("SUBAGENT-TRANSCRIPT-CANARY");

        // 3) Dispose→reopen round-trip on the real file: the session reopens
        //    under the same ID with the run's messages intact.
        const reopened = SessionManager.open(resolved!);
        expect(reopened.getSessionId()).toBe(agentId);
        const restored = JSON.stringify(reopened.buildSessionContext().messages);
        expect(restored).toContain("summarize the project");
        expect(restored).toContain("SUBAGENT-TRANSCRIPT-CANARY: summary done");
      },
      TEST_TIMEOUT_MS,
    );
  },
);

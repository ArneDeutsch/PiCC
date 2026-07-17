import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
  BASH_AVAILABLE,
  cliMissing,
  createE2ELive,
  systemText,
  TEST_TIMEOUT_MS,
  toolResultText,
  CLI_PATH,
} from "./helpers/e2e-live.js";
import type { CapturedRequest } from "./helpers/mock-openai.js";
import { resolveSubagentTranscript } from "../src/util/subagent-transcripts.js";

/**
 * E2E — subagents (the heaviest lane; each scenario spawns a nested Pi child):
 * background dispatch + TaskOutput, worktree isolation, provider-error named
 * failure, and on-disk transcript persistence. See test/helpers/e2e-live.ts.
 */

const { runPi, cleanup } = createE2ELive();
afterEach(cleanup);

describe.skipIf(cliMissing)(
  "e2e subagents: real Pi CLI + PiCC extension + mock OpenAI model",
  () => {
    if (cliMissing) {
      // eslint-disable-next-line no-console
      console.warn(
        `Skipping live e2e tests: Pi CLI not found at ${CLI_PATH} — run npm install first.`,
      );
    }

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
        // No crash noise from the un-awaited dispatch (completeness floor).
        expect(result.stderr).not.toMatch(/UnhandledPromiseRejection|unhandledRejection|FATAL/i);
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
                message: "insufficient_quota: mock usage limit drained (E2E-API-DEATH)",
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

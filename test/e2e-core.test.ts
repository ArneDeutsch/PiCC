import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
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

/**
 * E2E — core wiring: full Claude project context assembled into the real
 * model request, and a /deploy slash-skill expanded through Pi's input event.
 * See test/helpers/e2e-live.ts for the shared runPi harness.
 */

const { runPi, cleanup } = createE2ELive();
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

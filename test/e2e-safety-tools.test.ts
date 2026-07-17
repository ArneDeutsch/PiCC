import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  allText,
  BASH_AVAILABLE,
  cliMissing,
  createE2ELive,
  PYTHON_BIN,
  TEST_TIMEOUT_MS,
  toolResultText,
  CLI_PATH,
} from "./helpers/e2e-live.js";

/**
 * E2E — safety + tool/shell dispatch: the Read(.env) deny rule enforced live
 * across the real model boundary, and a bash tool call through Git Bash with
 * the python cp1252/UTF-8 encoding boundary. See test/helpers/e2e-live.ts.
 */

const { runPi, cleanup } = createE2ELive();
afterEach(cleanup);

describe.skipIf(cliMissing)(
  "e2e safety+tools: real Pi CLI + PiCC extension + mock OpenAI model",
  () => {
    if (cliMissing) {
      // eslint-disable-next-line no-console
      console.warn(
        `Skipping live e2e tests: Pi CLI not found at ${CLI_PATH} — run npm install first.`,
      );
    }

    it(
      "enforces the Read(.env) deny rule live and never leaks the secret to the model",
      async () => {
        const result = await runPi({
          script: [{ toolCalls: [{ name: "read", args: { path: ".env" } }] }, { text: "ok" }],
          prompt: "read the env file",
          setup: (dir) => fs.writeFileSync(path.join(dir, ".env"), "SECRET=TOP-SECRET-VALUE\n"),
        });

        expect(result.code).toBe(0);
        expect(result.requests.length).toBeGreaterThanOrEqual(2);
        const second = result.requests[1]!;

        // The tool result sent back marks the call as denied/blocked.
        expect(toolResultText(second)).toMatch(/deny|blocked/i);

        // The secret never reaches the model in any request.
        for (const [i, request] of result.requests.entries()) {
          expect(allText(request), `request ${i} must not leak .env content`).not.toContain(
            "TOP-SECRET-VALUE",
          );
        }
      },
      TEST_TIMEOUT_MS,
    );

    // --- Scenario 1: bash tool runs a real project script (Git Bash, not WSL stub) ---
    // Also absorbs the Python cp1252/UTF-8 boundary (t03 merge): when a python
    // interpreter is available, the SAME bash call additionally prints U+2192 via
    // chr(0x2192) and we assert it round-trips with no UnicodeEncodeError/charmap.
    // The python portion (command + assertion) is omitted entirely when python is
    // absent — the scenario stays gated only on BASH_AVAILABLE, never hard-requires
    // python.
    it.skipIf(!BASH_AVAILABLE)(
      "runs a bash tool call through Git Bash and round-trips real stdout",
      async () => {
        const arrow = String.fromCharCode(0x2192); // U+2192 RIGHTWARDS ARROW
        // chr(0x2192) keeps the literal arrow out of the command string.
        const pythonProbe = PYTHON_BIN
          ? ` && ${PYTHON_BIN} -c "print('arrow-' + chr(0x2192) + '-end')"`
          : "";
        const result = await runPi({
          script: [
            {
              toolCalls: [
                {
                  name: "bash",
                  args: {
                    command:
                      "echo PCD_BASH_OK && node -e \"console.log('node-'+(1+1))\"" + pythonProbe,
                  },
                },
              ],
            },
            { text: "ran it" },
          ],
          prompt: "run the probe",
        });

        expect(result.code).toBe(0);
        expect(result.requests.length).toBeGreaterThanOrEqual(2);
        const toolResult = toolResultText(result.requests[1]!);
        expect(toolResult).toContain("PCD_BASH_OK");
        expect(toolResult).toContain("node-2");
        // cp1252/UTF-8 boundary: only asserted when python actually ran (gated on
        // PYTHON_BIN), so absence of python skips just this portion, not the test.
        if (PYTHON_BIN) {
          expect(toolResult).toContain(`arrow-${arrow}-end`);
          expect(toolResult).not.toMatch(/UnicodeEncodeError|charmap/i);
        }
      },
      TEST_TIMEOUT_MS,
    );
  },
);

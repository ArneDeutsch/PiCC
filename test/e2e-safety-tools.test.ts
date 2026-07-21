import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RECORD_EXPAND_HINT } from "../src/runtime/subagent-render.js";
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

const CONTROLLED_PRESENTATION_LITERALS = [
  "diff hidden",
  "output hidden",
  "line hidden",
  "lines hidden",
  "command line hidden",
  "command lines hidden",
  "no net change",
  "(no output)",
  "to expand",
  "Elaborated result",
  "Renderer failed",
  "Unfamiliar result",
  "Unfamiliar arguments",
  "Detail inspection limit reached",
  "Native cleanup failed",
  "Edit preview failed",
  "edit details too large",
  "remaining detail uninspected",
  "details uninspected",
  "display only; tool data unchanged",
  "presentation failure",
  "settled result elaborated",
  RECORD_EXPAND_HINT,
] as const;
function expectNoPresentationLiterals(value: string): void {
  const lower = value.toLowerCase();
  for (const literal of CONTROLLED_PRESENTATION_LITERALS) {
    expect(lower).not.toContain(literal.toLowerCase());
  }
}

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
    // Also absorbs the Python cp1252/UTF-8 boundary: when a python
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
        const command = "echo PCD_BASH_OK && node -e \"console.log('node-'+(1+1))\"" + pythonProbe;
        const result = await runPi({
          persistSession: true,
          script: [
            {
              toolCalls: [
                {
                  name: "bash",
                  args: { command },
                },
              ],
            },
            { text: "ran it" },
          ],
          prompt: "run the probe",
        });

        expect(result.code).toBe(0);
        expect(result.requests.length).toBeGreaterThanOrEqual(2);
        const expectedOutput = [
          "PCD_BASH_OK",
          "node-2",
          ...(PYTHON_BIN ? [`arrow-${arrow}-end`] : []),
        ].join("\n") + (PYTHON_BIN && process.platform === "win32" ? "\r\n" : "\n");
        const secondRequest = result.requests[1]!;
        const toolResult = toolResultText(secondRequest);
        expect(toolResult).toBe(expectedOutput);
        const modelToolMessages = secondRequest.messages.filter((message) => message.role === "tool");
        expect(modelToolMessages).toHaveLength(1);
        expect(modelToolMessages[0]!.role).toBe("tool");
        expect(modelToolMessages[0]!.content).toBe(expectedOutput);
        expect(typeof modelToolMessages[0]!.tool_call_id).toBe("string");
        expectNoPresentationLiterals(toolResult);
        expectNoPresentationLiterals(result.stdout);
        // cp1252/UTF-8 boundary: only asserted when python actually ran (gated on
        // PYTHON_BIN), so absence of python skips just this portion, not the test.
        if (PYTHON_BIN) {
          expect(toolResult).toContain(`arrow-${arrow}-end`);
          expect(toolResult).not.toMatch(/UnicodeEncodeError|charmap/i);
        }

        // Pi stores main sessions under <agentDir>/sessions/<encoded-cwd>/*.jsonl.
        const sessionFiles: string[] = [];
        const collectSessionFiles = (directory: string): void => {
          for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
            const full = path.join(directory, entry.name);
            if (entry.isDirectory()) collectSessionFiles(full);
            else if (entry.name.endsWith(".jsonl")) sessionFiles.push(full);
          }
        };
        collectSessionFiles(path.join(result.agentDir, "sessions"));
        expect(sessionFiles).toHaveLength(1);
        const transcript = fs.readFileSync(sessionFiles[0]!, "utf8");
        expect(transcript.endsWith("\n")).toBe(true);
        const entries = transcript.slice(0, -1).split("\n").map((line, index) => {
          expect(line, `session frame ${index} must be nonempty`).not.toBe("");
          return JSON.parse(line) as Record<string, unknown>;
        });
        const messages = entries
          .filter((entry) => entry.type === "message")
          .map((entry) => entry.message as Record<string, unknown>);
        const assistant = messages.find((message) => message.role === "assistant" &&
          Array.isArray(message.content) && message.content.some((block) =>
            (block as { type?: unknown; name?: unknown }).type === "toolCall" &&
            (block as { name?: unknown }).name === "bash"));
        expect(assistant).toBeDefined();
        const calls = (assistant!.content as Array<Record<string, unknown>>)
          .filter((block) => block.type === "toolCall" && block.name === "bash");
        expect(calls).toHaveLength(1);
        expect(calls[0]!.arguments).toEqual({ command });
        const toolCallId = calls[0]!.id;
        const storedResults = messages.filter((message) => message.role === "toolResult" &&
          message.toolCallId === toolCallId && message.toolName === "bash");
        expect(storedResults).toHaveLength(1);
        expect(modelToolMessages[0]!.tool_call_id).toBe(toolCallId);
        expect(storedResults[0]!.content).toEqual([{ type: "text", text: expectedOutput }]);
        expect(storedResults[0]!.isError).toBe(false);
        expectNoPresentationLiterals(JSON.stringify({ call: calls[0], result: storedResults[0] }));
      },
      TEST_TIMEOUT_MS,
    );

    it.skipIf(!BASH_AVAILABLE).each(["json", "rpc"] as const)(
      "%s mode emits canonical Bash results at the real CLI output boundary",
      async (mode) => {
        const marker = `T04_${mode.toUpperCase()}_CANONICAL_OUTPUT`;
        const effectToken = `T04_${mode.toUpperCase()}_APPEND_ONCE`;
        const effectFile = `t04-${mode}-append.txt`;
        const command = `printf '%s' '${effectToken}' >> '${effectFile}'; printf '%s' '${marker}'`;
        const result = await runPi({
          mode,
          setup: (dir) => fs.writeFileSync(path.join(dir, effectFile), ""),
          script: [
            {
              toolCalls: [{
                name: "bash",
                args: { command },
              }],
            },
            { text: "done" },
          ],
          prompt: `run the ${mode} output probe`,
        });

        if (mode === "json") expect(result.code, result.stderr).toBe(0);
        else expect(result.stderr).not.toMatch(/Assertion failed|UV_HANDLE_CLOSING/i);
        expect(result.stdout.endsWith("\n")).toBe(true);
        expect(result.stdout).not.toContain("\r\n");

        const events = result.jsonl as Array<Record<string, unknown>>;
        const starts = events.filter((event) => event.type === "tool_execution_start" && event.toolName === "bash");
        const ends = events.filter((event) => event.type === "tool_execution_end" && event.toolName === "bash");
        const settlements = events.filter((event) => event.type === "agent_settled");
        expect(starts).toHaveLength(1);
        expect(ends).toHaveLength(1);
        expect(settlements).toEqual([{ type: "agent_settled" }]);
        const start = starts[0]!;
        const end = ends[0]!;
        const toolCallId = start.toolCallId;
        expect(typeof toolCallId).toBe("string");
        expect(start).toEqual({
          type: "tool_execution_start",
          toolCallId,
          toolName: "bash",
          args: { command },
        });
        expect(end).toEqual({
          type: "tool_execution_end",
          toolCallId,
          toolName: "bash",
          result: { content: [{ type: "text", text: marker }] },
          isError: false,
        });

        const protocolText = JSON.stringify(events);
        expectNoPresentationLiterals(protocolText);
        const startIndex = events.indexOf(start);
        const endIndex = events.indexOf(end);
        const settledIndex = events.indexOf(settlements[0]!);
        expect(startIndex).toBeLessThan(endIndex);
        expect(endIndex).toBeLessThan(settledIndex);
        if (mode === "rpc") {
          const responses = events.filter((event) => event.type === "response" && event.id === "e2e-prompt");
          expect(responses).toEqual([{
            id: "e2e-prompt", type: "response", command: "prompt", success: true,
          }]);
          const responseIndex = events.indexOf(responses[0]!);
          // Pi emits prompt success from preflight before beginning tool execution.
          expect(responseIndex).toBeLessThan(startIndex);
        }
        expect(fs.readFileSync(path.join(result.fixture, effectFile), "utf8")).toBe(effectToken);
      },
      TEST_TIMEOUT_MS,
    );
  },
);

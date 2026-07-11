import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupFixture, materializeFixture } from "./helpers/fixture.js";
import { startMockModel, type CapturedRequest, type Turn } from "./helpers/mock-openai.js";

/**
 * Live end-to-end tests: the REAL Pi CLI (dist/cli.js) runs the assembled
 * PiClauDex extension against the hello-claude fixture, driven by a local mock
 * OpenAI-compatible model server — no real network, no subscription.
 *
 * Each scenario scripts the model's turns, spawns `pi -p`, and asserts on the
 * requests Pi actually sent to the "model" plus on-disk side effects.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI_PATH = path.join(
  REPO_ROOT,
  "node_modules",
  "@earendil-works",
  "pi-coding-agent",
  "dist",
  "cli.js",
);
const EXTENSION_PATH = path.join(REPO_ROOT, "src", "index.ts");
const cliMissing = !fs.existsSync(CLI_PATH);
const RUN_TIMEOUT_MS = 90_000;
const TEST_TIMEOUT_MS = 120_000;

const tempDirs: string[] = [];
const fixtures: string[] = [];

afterEach(() => {
  for (const dir of fixtures.splice(0)) cleanupFixture(dir);
  for (const dir of tempDirs.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
      /* OS reaps temp dirs eventually */
    }
  }
});

function makeAgentDir(mockUrl: string): string {
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pcd-piagent-"));
  tempDirs.push(agentDir);
  // Shape verified against pi docs/models.md ("Full Example") and docs/settings.md.
  fs.writeFileSync(
    path.join(agentDir, "models.json"),
    JSON.stringify(
      {
        providers: {
          mock: {
            baseUrl: `${mockUrl}/v1`,
            api: "openai-completions",
            apiKey: "test-key",
            models: [
              {
                id: "mock-1",
                name: "Mock",
                reasoning: false,
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 128000,
                maxTokens: 8192,
              },
            ],
          },
        },
      },
      null,
      2,
    ),
  );
  fs.writeFileSync(
    path.join(agentDir, "settings.json"),
    JSON.stringify(
      {
        defaultProvider: "mock",
        defaultModel: "mock-1",
        defaultProjectTrust: "always",
        compaction: { enabled: false },
      },
      null,
      2,
    ),
  );
  return agentDir;
}

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  requests: CapturedRequest[];
  fixture: string;
}

async function runPi(opts: {
  script: Turn[];
  prompt: string;
  setup?: (fixtureDir: string) => void;
}): Promise<RunResult> {
  const fixture = materializeFixture("hello-claude");
  fixtures.push(fixture);
  opts.setup?.(fixture);

  const mock = await startMockModel(opts.script);
  try {
    const agentDir = makeAgentDir(mock.url);
    const emptyUserDir = fs.mkdtempSync(path.join(os.tmpdir(), "pcd-claude-user-"));
    tempDirs.push(emptyUserDir);

    const child = spawn(
      process.execPath,
      [CLI_PATH, "-e", EXTENSION_PATH, "--no-session", "-p", opts.prompt],
      {
        cwd: fixture,
        env: {
          ...process.env,
          PI_CODING_AGENT_DIR: agentDir,
          // Disables Pi's startup network operations (update check, install
          // telemetry) only — provider requests to the local mock still flow.
          PI_OFFLINE: "1",
          PI_SKIP_VERSION_CHECK: "1",
          PICLAUDEX_CLAUDE_USER_DIR: emptyUserDir,
          NO_COLOR: "1",
        },
        // stdin must be closed: Pi's print mode waits on piped stdin otherwise.
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    const killTimer = setTimeout(() => child.kill(), RUN_TIMEOUT_MS);
    const code = await new Promise<number | null>((resolve) => child.on("close", resolve));
    clearTimeout(killTimer);
    return { code, stdout, stderr, requests: mock.requests, fixture };
  } finally {
    await mock.close();
  }
}

/** All message content of a request as one searchable string. */
function allText(request: CapturedRequest): string {
  return JSON.stringify(request.messages);
}

/** Concatenated system/developer message content of a request. */
function systemText(request: CapturedRequest): string {
  return request.messages
    .filter((m) => m.role === "system" || m.role === "developer")
    .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
    .join("\n");
}

/** Concatenated role:"tool" (tool result) message content of a request. */
function toolResultText(request: CapturedRequest): string {
  return request.messages
    .filter((m) => m.role === "tool")
    .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
    .join("\n");
}

describe.skipIf(cliMissing)(
  "e2e: real Pi CLI + PiClauDex extension + mock OpenAI model",
  () => {
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
        const toolNames = (first.tools ?? []).map(
          (t) => (t as { function?: { name?: string } }).function?.name,
        );
        for (const expected of ["write", "read", "bash", "Skill", "Agent", "EnterWorktree"]) {
          expect(toolNames, `tool ${expected} advertised`).toContain(expected);
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
      "executes a scripted write tool call and round-trips the result to the model",
      async () => {
        const result = await runPi({
          script: [
            { toolCalls: [{ name: "write", args: { path: "hello-out.txt", content: "from-mock" } }] },
            { text: "wrote it" },
          ],
          prompt: "write hello-out.txt",
        });

        expect(result.code).toBe(0);
        // The tool actually ran: the file exists in the fixture.
        const outPath = path.join(result.fixture, "hello-out.txt");
        expect(fs.existsSync(outPath), `expected ${outPath} to exist`).toBe(true);
        expect(fs.readFileSync(outPath, "utf8")).toBe("from-mock");

        // The second request carries the tool result back to the model.
        expect(result.requests.length).toBeGreaterThanOrEqual(2);
        const second = result.requests[1]!;
        expect(toolResultText(second)).toMatch(/wrote|hello-out\.txt/i);

        // PreToolUse warn hook (matcher Write|Edit) emitted additionalContext;
        // the guard steers it in as a message, and Pi print mode delivers it —
        // observed live as a user message in the follow-up request.
        expect(allText(second)).toContain("warn-only-guard: writing files is being watched");
      },
      TEST_TIMEOUT_MS,
    );

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

    it(
      "activates the greet skill via the Skill tool with $1 substitution",
      async () => {
        const result = await runPi({
          script: [
            { toolCalls: [{ name: "Skill", args: { name: "greet", arguments: "Ada" } }] },
            { text: "done" },
          ],
          prompt: "greet Ada",
        });

        expect(result.code).toBe(0);
        expect(result.requests.length).toBeGreaterThanOrEqual(2);
        const second = result.requests[1]!;
        const toolResult = toolResultText(second);
        expect(toolResult).toContain("GREET-SKILL-BODY");
        expect(toolResult).toContain("named **Ada**");
      },
      TEST_TIMEOUT_MS,
    );

    it(
      "creates and enters a real git worktree via EnterWorktree",
      async () => {
        const result = await runPi({
          script: [{ toolCalls: [{ name: "EnterWorktree", args: { name: "e2e" } }] }, { text: "in" }],
          prompt: "enter a worktree named e2e",
        });

        expect(result.code).toBe(0);
        const worktreeDir = path.join(result.fixture, ".claude", "worktrees", "e2e");
        expect(fs.existsSync(worktreeDir), `expected worktree at ${worktreeDir}`).toBe(true);
        // A linked git worktree has a .git *file* pointing at the main repo.
        const gitPointer = path.join(worktreeDir, ".git");
        expect(fs.existsSync(gitPointer)).toBe(true);
        expect(fs.statSync(gitPointer).isFile()).toBe(true);
        expect(fs.readFileSync(gitPointer, "utf8")).toContain("gitdir:");

        // The tool result confirms the cwd swap to the model.
        expect(result.requests.length).toBeGreaterThanOrEqual(2);
        expect(toolResultText(result.requests[1]!)).toMatch(/entered worktree/i);
      },
      TEST_TIMEOUT_MS,
    );
  },
);

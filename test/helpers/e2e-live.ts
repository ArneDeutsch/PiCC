import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cleanupFixture, materializeFixture } from "./fixture.js";
import { startMockModel, type CapturedRequest, type Turn } from "./mock-openai.js";
import { resolveShellBinary } from "../../src/engine/shell-inject.js";

/**
 * Shared harness for the live end-to-end tests: the REAL Pi CLI (dist/cli.js)
 * runs the assembled PiCC extension against a materialized fixture, driven by a
 * local mock OpenAI-compatible model server — no real network, no subscription.
 *
 * Each scenario scripts the model's turns, spawns `pi -p`, and asserts on the
 * requests Pi actually sent to the "model" plus on-disk side effects.
 *
 * The stateful part (`runPi` + its per-run temp/fixture bookkeeping) is exposed
 * via the `createE2ELive()` factory so every split `test/e2e-*.test.ts` file gets
 * its own isolated `tempDirs`/`fixtures` arrays and `afterEach` cleanup without
 * relying on vitest module-reuse semantics.
 */

// This file lives in test/helpers/, so REPO_ROOT is two levels up (mirrors
// test/helpers/fixture.ts). CLI_PATH/EXTENSION_PATH/cliMissing cascade from it.
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const CLI_PATH = path.join(
  REPO_ROOT,
  "node_modules",
  "@earendil-works",
  "pi-coding-agent",
  "dist",
  "cli.js",
);
export const EXTENSION_PATH = path.join(REPO_ROOT, "src", "index.ts");
export const cliMissing = !fs.existsSync(CLI_PATH);
export const RUN_TIMEOUT_MS = 90_000;
export const TEST_TIMEOUT_MS = 120_000;

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  requests: CapturedRequest[];
  fixture: string;
  /** The per-run PI_CODING_AGENT_DIR (sessions land under <agentDir>/sessions). */
  agentDir: string;
}

export type FixtureName = "hello-claude" | "full-surface";

export interface RunPiOptions {
  script: Turn[];
  prompt: string;
  fixture?: FixtureName;
  extraEnv?: Record<string, string>;
  setup?: (fixtureDir: string) => void;
  /** Override the synthetic stored credential for the default mock model. */
  defaultModelCredential?: string;
  /** A second local provider/model, authenticated only by a synthetic stored credential. */
  secondaryModel?: { provider: string; id: string; credential: string };
  /** Keep session persistence ON (drops --no-session) — transcript scenarios. */
  persistSession?: boolean;
}

export interface E2ELive {
  runPi: (opts: RunPiOptions) => Promise<RunResult>;
  cleanup: () => void;
}

/**
 * Create an isolated e2e harness instance. Each split test file calls this once
 * at module scope and wires `afterEach(cleanup)`, so per-run temp dirs and
 * fixtures never leak across files.
 */
export function createE2ELive(): E2ELive {
  const tempDirs: string[] = [];
  const fixtures: string[] = [];

  function makeAgentDir(
    mockUrl: string,
    defaultModelCredential: string,
    secondaryModel?: RunPiOptions["secondaryModel"],
  ): string {
    const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pcd-piagent-"));
    tempDirs.push(agentDir);
    const model = (id: string, name: string) => ({
      id,
      name,
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128000,
      maxTokens: 8192,
    });
    const providers: Record<string, unknown> = {
      mock: {
        baseUrl: `${mockUrl}/v1`,
        api: "openai-completions",
        models: [model("mock-1", "Mock")],
      },
    };
    const credentials: Record<string, unknown> = {
      mock: { type: "api_key", key: defaultModelCredential },
    };
    if (secondaryModel) {
      providers[secondaryModel.provider] = {
        baseUrl: `${mockUrl}/v1`,
        api: "openai-completions",
        models: [model(secondaryModel.id, "Secondary Mock")],
      };
      credentials[secondaryModel.provider] = {
        type: "api_key",
        key: secondaryModel.credential,
      };
    }
    // Models stay credential-blind; auth.json exercises Pi's stored-credential path.
    fs.writeFileSync(
      path.join(agentDir, "models.json"),
      JSON.stringify({ providers }, null, 2),
    );
    fs.writeFileSync(
      path.join(agentDir, "auth.json"),
      JSON.stringify(credentials, null, 2),
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

  async function runPi(opts: RunPiOptions): Promise<RunResult> {
    const fixture = materializeFixture(opts.fixture ?? "hello-claude");
    fixtures.push(fixture);
    opts.setup?.(fixture);

    const defaultModelCredential =
      opts.defaultModelCredential ?? "synthetic-default-model-key";
    const authorizationDigest = (credential: string) =>
      createHash("sha256").update(`Bearer ${credential}`).digest("hex");
    const authorizationDigestsByModel = new Map<string, string>([
      ["mock-1", authorizationDigest(defaultModelCredential)],
      ...(opts.secondaryModel
        ? [[opts.secondaryModel.id, authorizationDigest(opts.secondaryModel.credential)] as const]
        : []),
    ]);
    const mock = await startMockModel(opts.script, authorizationDigestsByModel);
    try {
      const agentDir = makeAgentDir(mock.url, defaultModelCredential, opts.secondaryModel);
      const emptyUserDir = fs.mkdtempSync(path.join(os.tmpdir(), "pcd-claude-user-"));
      tempDirs.push(emptyUserDir);

      const child = spawn(
        process.execPath,
        [
          CLI_PATH,
          "-e",
          EXTENSION_PATH,
          ...(opts.persistSession ? [] : ["--no-session"]),
          "-p",
          opts.prompt,
        ],
        {
          cwd: fixture,
          env: {
            ...process.env,
            PI_CODING_AGENT_DIR: agentDir,
            // Disables Pi's startup network operations (update check, install
            // telemetry) only — provider requests to the local mock still flow.
            PI_OFFLINE: "1",
            PI_SKIP_VERSION_CHECK: "1",
            PICC_CLAUDE_USER_DIR: emptyUserDir,
            NO_COLOR: "1",
            ...opts.extraEnv,
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
      return { code, stdout, stderr, requests: mock.requests, fixture, agentDir };
    } finally {
      await mock.close();
    }
  }

  function cleanup(): void {
    for (const dir of fixtures.splice(0)) cleanupFixture(dir);
    for (const dir of tempDirs.splice(0)) {
      try {
        fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      } catch {
        /* OS reaps temp dirs eventually */
      }
    }
  }

  return { runPi, cleanup };
}

/** All message content of a request as one searchable string. */
export function allText(request: CapturedRequest): string {
  return JSON.stringify(request.messages);
}

/** Concatenated system/developer message content of a request. */
export function systemText(request: CapturedRequest): string {
  return request.messages
    .filter((m) => m.role === "system" || m.role === "developer")
    .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
    .join("\n");
}

/** Concatenated role:"tool" (tool result) message content of a request. */
export function toolResultText(request: CapturedRequest): string {
  return request.messages
    .filter((m) => m.role === "tool")
    .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
    .join("\n");
}

/** Concatenated role:"user" message content of a request. */
export function userText(request: CapturedRequest): string {
  return request.messages
    .filter((m) => m.role === "user")
    .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
    .join("\n");
}

/** The advertised tool names for a request (the `tools[].function.name` list). */
export function toolNames(request: CapturedRequest): (string | undefined)[] {
  return (request.tools ?? []).map(
    (t) => (t as { function?: { name?: string } }).function?.name,
  );
}

/**
 * Detect a usable `bash`, skip cleanly if absent. Uses the extension's OWN
 * Git Bash resolution (resolveShellBinary skips the System32 WSL stub and
 * also finds per-user Git installs under LOCALAPPDATA), so the tests probe
 * exactly the binary the extension will spawn.
 */
export const BASH_AVAILABLE = (() => {
  for (const cand of [resolveShellBinary("bash"), "C:\\Program Files\\Git\\bin\\bash.exe"]) {
    try {
      execFileSync(cand, ["--version"], { stdio: "ignore" });
      return true;
    } catch {
      /* try next */
    }
  }
  return false;
})();

/** Detect a python interpreter name on PATH, or undefined. */
export const PYTHON_BIN = (() => {
  for (const cand of ["python", "python3", "py"]) {
    try {
      execFileSync(cand, ["--version"], { stdio: "ignore" });
      return cand;
    } catch {
      /* try next */
    }
  }
  return undefined;
})();

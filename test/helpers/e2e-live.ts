import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cleanupFixture, materializeFixture } from "./fixture.js";
import { startMockModel, type CapturedRequest, type RequestClassifierOptions, type Turn } from "./mock-openai.js";
import { resolveRealPiCli } from "../../scripts/resolve-real-pi-cli.mjs";
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
// test/helpers/fixture.ts). The package preflight and this direct-Vitest skip
// resolve the real Pi CLI through the same module.
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const realPiCli = resolveRealPiCli({ repoRoot: REPO_ROOT });
export const CLI_PATH = realPiCli.cliPath;
export const EXTENSION_PATH = path.join(REPO_ROOT, "src", "index.ts");
export const cliMissing = realPiCli.missing;
export const RUN_TIMEOUT_MS = 90_000;
export const TEST_TIMEOUT_MS = 120_000;
export const CHECKPOINT_USAGE = Object.freeze({
  prompt_tokens: 90_000,
  completion_tokens: 100,
  total_tokens: 90_100,
});
export const CHECKPOINT_CONTEXT_WINDOW = 100_000;
export const CHECKPOINT_PI_SETTINGS = Object.freeze({
  compaction: Object.freeze({ enabled: false, reserveTokens: 100, keepRecentTokens: 1 }),
});

export function writeCheckpointConfig(fixtureDir: string): void {
  const configDir = path.join(fixtureDir, ".claude", ".picc");
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, "config.json"), JSON.stringify({ proactiveCompactPercent: 90 }));
}

export function findSessionFiles(agentDir: string): string[] {
  const files: string[] = [];
  const walk = (dir: string): void => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".jsonl")) files.push(full);
    }
  };
  walk(path.join(agentDir, "sessions"));
  return files;
}

export interface JsonLineObject {
  readonly [key: string]: unknown;
}

export function readJsonLines(text: string): JsonLineObject[] {
  return text.trim().split(/\r?\n/u).filter(Boolean).map((line) => {
    const value: unknown = JSON.parse(line);
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("Expected each JSONL record to be an object");
    }
    return value as JsonLineObject;
  });
}

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
  classifier?: RequestClassifierOptions;
  fixture?: FixtureName;
  extraEnv?: Record<string, string>;
  setup?: (fixtureDir: string) => void;
  /** Override the synthetic stored credential for the default mock model. */
  defaultModelCredential?: string;
  /** A second local provider/model, authenticated only by a synthetic stored credential. */
  secondaryModel?: { provider: string; id: string; credential: string };
  /** Keep session persistence ON (drops --no-session) — transcript scenarios. */
  persistSession?: boolean;
  /** Override model capacity for deterministic usage-threshold scenarios. */
  contextWindow?: number;
  /** Merge into the real Pi settings file. */
  piSettings?: Record<string, unknown>;
  /** CLI mode arguments replacing print `-p <prompt>` (RPC/JSON contract tests). */
  modeArgs?: string[];
  /** Run an installed PiCC launcher instead of the source Pi CLI + explicit extension. */
  launcherPath?: string;
}

export interface StartedPi {
  requests: CapturedRequest[];
  waitForRequest(
    predicate?: (request: CapturedRequest) => boolean,
    count?: number,
    timeoutMs?: number,
  ): Promise<CapturedRequest>;
  waitForOutput(
    predicate: (record: Record<string, unknown>) => boolean,
    timeoutMs?: number,
    count?: number,
  ): Promise<Record<string, unknown>>;
  sendInput(line: string): void;
  closeInput(): void;
  completion: Promise<RunResult>;
  stop(): Promise<void>;
}

export interface E2ELive {
  startPi: (opts: RunPiOptions) => Promise<StartedPi>;
  runPi: (opts: RunPiOptions) => Promise<RunResult>;
  cleanup: () => Promise<void>;
}

/**
 * Create an isolated e2e harness instance. Each split test file calls this once
 * at module scope and wires `afterEach(cleanup)`, so per-run temp dirs and
 * fixtures never leak across files.
 */
export function createE2ELive(): E2ELive {
  const tempDirs: string[] = [];
  const fixtures: string[] = [];
  const retainedTempDirs = new Set<string>();
  const retainedFixtures = new Set<string>();
  const active = new Set<StartedPi>();

  function makeAgentDir(
    mockUrl: string,
    defaultModelCredential: string,
    secondaryModel?: RunPiOptions["secondaryModel"],
    contextWindow = 128000,
    extraSettings: Record<string, unknown> = {},
  ): string {
    const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "pcd-piagent-"));
    tempDirs.push(agentDir);
    const model = (id: string, name: string) => ({
      id,
      name,
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow,
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
          ...extraSettings,
        },
        null,
        2,
      ),
    );
    return agentDir;
  }

  async function startPi(opts: RunPiOptions): Promise<StartedPi> {
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
    const mock = await startMockModel(opts.script, opts.classifier, authorizationDigestsByModel);
    const agentDir = makeAgentDir(
      mock.url,
      defaultModelCredential,
      opts.secondaryModel,
      opts.contextWindow,
      opts.piSettings,
    );
    const emptyUserDir = fs.mkdtempSync(path.join(os.tmpdir(), "pcd-claude-user-"));
    tempDirs.push(emptyUserDir);
    let child: ChildProcess | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let stdout = "";
    let stderr = "";
    let closed: Promise<number | null> | undefined;
    const outputRecords: Record<string, unknown>[] = [];
    const outputWaiters = new Set<{
      predicate: (record: Record<string, unknown>) => boolean;
      count: number;
      resolve: (record: Record<string, unknown>) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }>();
    let started: StartedPi | undefined;
    let finalization: Promise<void> | undefined;
    let finalized = false;
    const finalizeRun = (retainRunPaths: boolean): Promise<void> => {
      if (retainRunPaths) {
        retainedFixtures.add(fixture);
        retainedTempDirs.add(agentDir);
        retainedTempDirs.add(emptyUserDir);
      }
      finalization ??= (async () => {
        try {
          if (killTimer) clearTimeout(killTimer);
          await mock.close();
          const error = new Error("Pi run finalized while waiting for output");
          for (const waiter of outputWaiters) {
            clearTimeout(waiter.timer);
            waiter.reject(error);
          }
          outputWaiters.clear();
        } finally {
          finalized = true;
          if (started) active.delete(started);
        }
      })();
      return finalization;
    };
    const waitForClose = async (timeoutMs: number): Promise<boolean> => {
      if (!closed) return true;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          closed.then(() => true),
          new Promise<false>((resolve) => {
            timer = setTimeout(() => resolve(false), timeoutMs);
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    };
    let stopOperation: Promise<void> | undefined;
    const stop = (): Promise<void> => {
      stopOperation ??= (async () => {
        if (!child) return;
        if (child.exitCode !== null || child.signalCode !== null) {
          if (await waitForClose(5_000)) return;
          if (process.platform === "win32") {
            await finalizeRun(true);
            throw new Error("Pi process exited but did not report close within 5000ms");
          }
        }

        const pid = child.pid;
        if (process.platform === "win32") {
          if (pid === undefined) {
            await finalizeRun(true);
            throw new Error("Pi process has no PID for Windows tree termination");
          }
          const termination = spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], {
            stdio: "ignore",
            windowsHide: true,
            timeout: 3_000,
          });
          if (await waitForClose(5_000)) return;
          await finalizeRun(true);
          const detail = termination.error?.message ?? `status ${termination.status ?? "unknown"}`;
          throw new Error(`Pi process tree ${pid} did not close after taskkill (${detail})`);
        }

        if (pid === undefined || pid <= 0) {
          await finalizeRun(true);
          throw new Error("Pi process has no valid PID for process-group termination");
        }
        try {
          process.kill(-pid, "SIGTERM");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
            await finalizeRun(true);
            throw error;
          }
        }
        if (await waitForClose(2_000)) return;
        try {
          process.kill(-pid, "SIGKILL");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
            await finalizeRun(true);
            throw error;
          }
        }
        if (await waitForClose(5_000)) return;
        await finalizeRun(true);
        throw new Error(`Pi process group ${pid} did not close after SIGKILL`);
      })();
      return stopOperation;
    };
    try {
      child = spawn(
        process.execPath,
        [
          ...(opts.launcherPath
            ? [opts.launcherPath]
            : [CLI_PATH, "-e", EXTENSION_PATH]),
          ...(opts.persistSession ? [] : ["--no-session"]),
          ...(opts.modeArgs ?? ["-p", opts.prompt]),
        ],
        {
          cwd: fixture,
          env: {
            ...process.env,
            PI_CODING_AGENT_DIR: agentDir,
            PI_OFFLINE: "1",
            PI_SKIP_VERSION_CHECK: "1",
            PICC_CLAUDE_USER_DIR: emptyUserDir,
            NO_COLOR: "1",
            ...opts.extraEnv,
          },
          stdio: [opts.modeArgs?.includes("rpc") ? "pipe" : "ignore", "pipe", "pipe"],
          windowsHide: true,
          detached: process.platform !== "win32",
        },
      );
      let outputRemainder = "";
      child.stdout!.on("data", (d: Buffer) => {
        const text = d.toString();
        stdout += text;
        outputRemainder += text;
        const lines = outputRemainder.split(/\r?\n/u);
        outputRemainder = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          let record: Record<string, unknown>;
          try { record = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
          outputRecords.push(record);
          for (const waiter of [...outputWaiters]) {
            if (!waiter.predicate(record) || outputRecords.filter(waiter.predicate).length < waiter.count) continue;
            outputWaiters.delete(waiter);
            clearTimeout(waiter.timer);
            waiter.resolve(record);
          }
        }
      });
      child.stderr!.on("data", (d: Buffer) => (stderr += d.toString()));
      closed = new Promise<number | null>((resolve, reject) => {
        child!.once("error", reject);
        child!.once("close", resolve);
      });
      killTimer = setTimeout(() => {
        void stop().catch(() => undefined);
      }, RUN_TIMEOUT_MS);
      const completion = (async (): Promise<RunResult> => {
        try {
          const code = await closed;
          return { code, stdout, stderr, requests: mock.requests, fixture, agentDir };
        } finally {
          await finalizeRun(false);
        }
      })();
      started = {
        requests: mock.requests,
        waitForRequest: (predicate, count, timeoutMs) => mock.waitForRequest(predicate, count, timeoutMs),
        waitForOutput: (predicate, timeoutMs = 10_000, count = 1) => {
          const existing = outputRecords.filter(predicate);
          if (existing.length >= count) return Promise.resolve(existing[count - 1]!);
          return new Promise<Record<string, unknown>>((resolve, reject) => {
            const waiter = {
              predicate, count, resolve, reject,
              timer: setTimeout(() => {
                outputWaiters.delete(waiter);
                reject(new Error(`Timed out waiting for Pi output; captured ${outputRecords.length} records`));
              }, timeoutMs),
            };
            outputWaiters.add(waiter);
          });
        },
        sendInput: (line) => child?.stdin?.write(`${line}\n`),
        closeInput: () => child?.stdin?.end(),
        completion,
        stop,
      };
      active.add(started);
      if (finalized) active.delete(started);
      return started;
    } catch (error) {
      if (killTimer) clearTimeout(killTimer);
      try { await stop(); } catch { /* continue with idempotent harness finalization */ }
      await finalizeRun(false);
      throw error;
    }
  }

  async function runPi(opts: RunPiOptions): Promise<RunResult> {
    return (await startPi(opts)).completion;
  }

  async function cleanup(): Promise<void> {
    await Promise.all([...active].map(async (run) => {
      let stopped = false;
      try {
        await run.stop();
        stopped = true;
      } catch { /* teardown continues after the bounded best-effort stop */ }
      if (stopped) {
        try { await run.completion; } catch { /* process closure is confirmed; absorb harness finalization failure */ }
      }
    }));
    for (const dir of fixtures.splice(0)) {
      if (!retainedFixtures.has(dir)) cleanupFixture(dir);
    }
    for (const dir of tempDirs.splice(0)) {
      if (retainedTempDirs.has(dir)) continue;
      try {
        fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      } catch {
        /* OS reaps temp dirs eventually */
      }
    }
  }

  return { startPi, runPi, cleanup };
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

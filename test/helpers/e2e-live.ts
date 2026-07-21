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
 * Each scenario scripts the model's turns, spawns Pi in the selected print/JSON/RPC mode, and
 * asserts on model requests, protocol output where applicable, and on-disk side effects.
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
  /** Parsed stdout records for JSON and RPC modes; empty in print mode. */
  jsonl: unknown[];
  requests: CapturedRequest[];
  fixture: string;
  /** The per-run PI_CODING_AGENT_DIR (sessions land under <agentDir>/sessions). */
  agentDir: string;
}

export type FixtureName = "hello-claude" | "full-surface";

export interface RunPiOptions {
  script: Turn[];
  prompt: string;
  mode?: "print" | "json" | "rpc";
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

/** Incrementally decode strict UTF-8, LF-framed JSON records. */
export class JsonlDecoder {
  readonly records: unknown[] = [];
  private readonly decoder = new TextDecoder("utf-8", { fatal: true });
  private pending = "";
  private failure: Error | undefined;

  constructor(
    private readonly onRecord?: (record: unknown) => void,
    private readonly onFailure?: (error: Error) => void,
  ) {}

  push(chunk: Buffer): void {
    if (this.failure) return;
    try {
      this.pending += this.decoder.decode(chunk, { stream: true });
      this.drain();
    } catch (error) {
      this.fail(new Error("Invalid UTF-8 in JSONL stream", { cause: error }));
    }
  }

  finish(): void {
    if (!this.failure) {
      try {
        this.pending += this.decoder.decode();
        this.drain();
      } catch (error) {
        this.fail(new Error("Invalid or truncated UTF-8 in JSONL stream", { cause: error }));
      }
    }
    if (!this.failure && this.pending.length > 0) {
      this.fail(new Error(`JSONL stream ended without LF framing: ${this.pending}`));
    }
    if (this.failure) throw this.failure;
  }

  private drain(): void {
    for (;;) {
      const lf = this.pending.indexOf("\n");
      if (lf < 0) return;
      const frame = this.pending.slice(0, lf);
      this.pending = this.pending.slice(lf + 1);
      if (frame.length === 0) {
        this.fail(new Error("Invalid JSONL empty frame"));
        return;
      }
      if (frame.endsWith("\r")) {
        this.fail(new Error("Invalid JSONL CRLF frame"));
        return;
      }
      try {
        const record: unknown = JSON.parse(frame);
        this.records.push(record);
        this.onRecord?.(record);
      } catch (error) {
        this.fail(new Error(`Invalid JSONL frame: ${frame}`, { cause: error }));
        return;
      }
    }
  }

  private fail(error: Error): void {
    if (this.failure) return;
    this.failure = error;
    this.onFailure?.(error);
  }
}

interface RpcRecord {
  id?: unknown;
  type?: unknown;
  command?: unknown;
  success?: unknown;
  error?: unknown;
  message?: unknown;
}

/** State machine for the one correlated prompt owned by an RPC e2e run. */
export class RpcPromptLifecycle {
  private responseSeen = false;
  private settled = false;
  private stopping = false;
  private failure: Error | undefined;

  observe(record: unknown): boolean {
    const value = record as RpcRecord | null;
    if (value?.type === "response" && value.id === "e2e-prompt" && value.command === "prompt") {
      if (this.responseSeen) this.fail("RPC emitted duplicate correlated e2e-prompt responses");
      this.responseSeen = true;
      if (value.success !== true) {
        const detail = value.error ?? value.message ?? "unspecified protocol error";
        this.fail(`RPC e2e-prompt failed: ${String(detail)}`);
      }
    } else if (value?.type === "agent_settled") {
      if (!this.responseSeen) this.fail("RPC agent settled before the correlated e2e-prompt response");
      else this.settled = true;
    }
    if ((this.failure || (this.responseSeen && this.settled)) && !this.stopping) {
      this.stopping = true;
      return true;
    }
    return false;
  }

  stdinError(error: Error & { code?: string }): boolean {
    if (error.code === "EPIPE" && this.stopping) return false;
    this.failure ??= new Error("RPC stdin failed", { cause: error });
    if (this.stopping) return false;
    this.stopping = true;
    return true;
  }

  timeout(): void {
    this.failure ??= new Error("RPC process exceeded the global timeout");
  }

  getFailure(): Error | undefined {
    return this.failure;
  }

  finish(code: number | null, signal: NodeJS.Signals | null, forcedFallback = false): void {
    if (this.failure) throw this.failure;
    if (!this.responseSeen) throw new Error("RPC process exited before the correlated e2e-prompt response");
    if (!this.settled) throw new Error("RPC process exited before agent settlement");
    if (!this.stopping) throw new Error("RPC process exited before intentional shutdown began");
    if (forcedFallback || signal === "SIGKILL") {
      throw new Error("RPC process required SIGKILL fallback after intentional shutdown");
    }
    if (code === 0 && signal === null) return;
    if (code === null && signal === "SIGTERM") return;
    if (code !== null) throw new Error(`RPC process exited with unexpected code ${code}`);
    throw new Error(`RPC process exited with unexpected signal ${signal ?? "none"}`);
  }

  private fail(message: string): void {
    this.failure ??= new Error(message);
  }
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

      const mode = opts.mode ?? "print";
      const child = spawn(
        process.execPath,
        [
          CLI_PATH,
          "-e",
          EXTENSION_PATH,
          ...(opts.persistSession ? [] : ["--no-session"]),
          ...(mode === "print" ? ["-p", opts.prompt]
            : mode === "json" ? ["--mode", "json", opts.prompt]
              : ["--mode", "rpc"]),
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
          // Print/JSON stdin stays closed; RPC alone owns a strict LF-framed pipe.
          stdio: [mode === "rpc" ? "pipe" : "ignore", "pipe", "pipe"],
          windowsHide: true,
        },
      );
      const stdoutChunks: Buffer[] = [];
      let stderr = "";
      let protocolFailure: Error | undefined;
      let timeoutFailure: Error | undefined;
      let forceKillTimer: NodeJS.Timeout | undefined;
      let cleanupWaitTimer: NodeJS.Timeout | undefined;
      let killTimer: NodeJS.Timeout | undefined;
      let shutdownStarted = false;
      let forcedFallback = false;
      const rpcLifecycle = mode === "rpc" ? new RpcPromptLifecycle() : undefined;
      const beginChildShutdown = () => {
        if (shutdownStarted) return;
        shutdownStarted = true;
        // Match Pi's own RpcClient: EOF races two shutdown paths on Windows,
        // while SIGTERM is the supported deterministic stop operation.
        child.kill("SIGTERM");
        forceKillTimer = setTimeout(() => {
          forcedFallback = true;
          child.kill("SIGKILL");
        }, 2_000);
      };
      const decoder = new JsonlDecoder(
        (record) => {
          if (!rpcLifecycle) return;
          const shouldStop = rpcLifecycle.observe(record);
          protocolFailure ??= rpcLifecycle.getFailure();
          if (shouldStop) beginChildShutdown();
        },
        (error) => {
          protocolFailure ??= error;
          beginChildShutdown();
        },
      );
      child.stdout!.on("data", (chunk: Buffer) => {
        const captured = Buffer.from(chunk);
        stdoutChunks.push(captured);
        if (mode !== "print") decoder.push(captured);
      });
      child.stderr!.on("data", (d: Buffer) => (stderr += d.toString()));
      if (mode === "rpc") {
        const stdin = child.stdin!;
        const captureInputError = (error: Error & { code?: string }) => {
          const shouldStop = rpcLifecycle!.stdinError(error);
          protocolFailure ??= rpcLifecycle!.getFailure();
          if (shouldStop) beginChildShutdown();
        };
        stdin.on("error", captureInputError);
        // Protocol framing is deliberately literal LF, never platform EOL.
        stdin.write(
          `${JSON.stringify({ id: "e2e-prompt", type: "prompt", message: opts.prompt })}\n`,
          (error) => { if (error) captureInputError(error); },
        );
      }
      killTimer = setTimeout(() => {
        timeoutFailure = new Error(`${mode} process exceeded the global timeout`);
        rpcLifecycle?.timeout();
        beginChildShutdown();
      }, RUN_TIMEOUT_MS);

      let exit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
      let waitFailure: unknown;
      try {
        exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
          child.once("error", reject);
          child.once("close", (code, signal) => resolve({ code, signal }));
        });
        if (mode !== "print") {
          try {
            decoder.finish();
          } catch (error) {
            protocolFailure ??= error instanceof Error ? error : new Error(String(error));
          }
        }
      } catch (error) {
        waitFailure = error;
        beginChildShutdown();
        await new Promise<void>((resolve) => {
          if (child.exitCode !== null || child.signalCode !== null) {
            resolve();
            return;
          }
          child.once("close", () => resolve());
          cleanupWaitTimer = setTimeout(resolve, 2_500);
        });
      } finally {
        if (killTimer) clearTimeout(killTimer);
        if (forceKillTimer) clearTimeout(forceKillTimer);
        if (cleanupWaitTimer) clearTimeout(cleanupWaitTimer);
      }

      if (protocolFailure) throw protocolFailure;
      if (waitFailure) throw waitFailure;
      if (!exit) throw new Error(`${mode} process wait ended without an exit result`);
      if (timeoutFailure) throw timeoutFailure;
      const stdout = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(stdoutChunks));
      if (rpcLifecycle) rpcLifecycle.finish(exit.code, exit.signal, forcedFallback);
      else if (exit.code === null) {
        throw new Error(`${mode} process exited without a code (signal: ${exit.signal ?? "none"})`);
      }
      return { code: exit.code, stdout, stderr, jsonl: decoder.records, requests: mock.requests, fixture, agentDir };
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

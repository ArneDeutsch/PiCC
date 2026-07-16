import { spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { waitUntil } from "./async.js";

const CHILD_SOURCE = String.raw`
import fs from "node:fs";
import path from "node:path";

const [mode, identity, output = ""] = process.argv.slice(2);
const root = process.env.HOOK_BARRIER_DIR;
if (!root || !mode || !identity) throw new Error("hook child protocol requires a root, mode, and identity");
const marker = (name) => path.join(root, name);
const publish = (name, value = "") => {
  const destination = marker(name);
  const temporary = destination + "." + process.pid + ".tmp";
  fs.writeFileSync(temporary, value, "utf8");
  fs.renameSync(temporary, destination);
};
const recordOutput = (stream, value) => {
  fs.appendFileSync(marker(identity + "." + stream), String(value), "utf8");
};
const waitForAny = (names, watchdog) => new Promise((resolve, reject) => {
  let retryTimer;
  const fail = (error) => {
    if (retryTimer) clearTimeout(retryTimer);
    reject(error);
  };
  const check = () => {
    if (names.some((name) => fs.existsSync(marker(name)))) resolve();
    else retryTimer = setTimeout(check, 10);
  };
  watchdog.catch(fail);
  check();
});

let rejectWatchdog;
const watchdog = new Promise((_, reject) => { rejectWatchdog = reject; });
const watchdogTimer = setTimeout(() => {
  const evidence = JSON.stringify({ root, mode, identity, pid: process.pid });
  publish(identity + ".watchdog-expired", evidence);
  rejectWatchdog(new Error("self-watchdog expired: " + evidence));
}, 12_000);

try {
  publish(identity + ".entered", JSON.stringify({ pid: process.pid, ppid: process.ppid }));
  if (mode === "parallel" || mode === "gate" || mode === "gate-block" || mode === "timeout") {
    await waitForAny([identity + ".release"], watchdog);
  } else if (mode === "reverse-first" || mode === "reverse-first-block") {
    await waitForAny(["second.done", identity + ".release"], watchdog);
  } else if (mode !== "reverse-second" && mode !== "reverse-second-block" && mode !== "complete") {
    throw new Error("unknown hook child mode: " + mode);
  }
  if (mode === "timeout") publish("post-timeout-side-effect");
  if (mode.endsWith("-block")) {
    if (output) {
      recordOutput("stderr", output);
      process.stderr.write(output);
    }
    process.exitCode = 2;
  } else if (output) {
    recordOutput("stdout", output);
    process.stdout.write(output);
  }
} catch (error) {
  const evidence = String(error);
  publish(identity + ".protocol-error", evidence);
  recordOutput("stderr", evidence + "\n");
  process.stderr.write(evidence + "\n");
  process.exitCode = 124;
} finally {
  clearTimeout(watchdogTimer);
  publish(identity + ".done", JSON.stringify({ pid: process.pid, exitCode: process.exitCode ?? 0 }));
}
`;

interface TrackedChild {
  child: ChildProcess;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  error?: string;
  closed: boolean;
}

export interface HookProcessFixture {
  readonly dir: string;
  readonly command: string;
  readonly env: Record<string, string>;
  readonly onSpawnForTest: (child: ChildProcess) => void;
  marker(name: string): string;
  exists(name: string): boolean;
  read(name: string): string;
  exitCode(identity: string): number;
  release(...identities: string[]): void;
  waitFor(names: string[], description: string, timeoutMs?: number): Promise<void>;
  spawnedChildren(): readonly ChildProcess[];
  isClosed(child: ChildProcess): boolean;
  waitForAllClosed(description?: string): Promise<void>;
  describe(): string;
  cleanup(...identitiesToRelease: string[]): Promise<void>;
}

/** Create the fixed Node child protocol in a deliberately shell-hostile path. */
export function createHookProcessFixture(parentDir: string): HookProcessFixture {
  const dir = path.join(parentDir, "hook fixture space's & $shell;chars");
  fs.mkdirSync(dir, { recursive: true });
  const script = path.join(dir, "hook child.mjs");
  fs.writeFileSync(script, CHILD_SOURCE, "utf8");
  const marker = (name: string) => path.join(dir, name);
  const exists = (name: string) => fs.existsSync(marker(name));
  const tracked: TrackedChild[] = [];

  const stateFor = (child: ChildProcess): TrackedChild | undefined =>
    tracked.find((state) => state.child === child);

  const fixture: HookProcessFixture = {
    dir,
    // Dynamic values cross bash only through separately quoted environment variables.
    command: 'exec "$HOOK_NODE" "$HOOK_SCRIPT"',
    env: {
      HOOK_NODE: process.execPath.replace(/\\/g, "/"),
      HOOK_SCRIPT: script.replace(/\\/g, "/"),
      HOOK_BARRIER_DIR: dir.replace(/\\/g, "/"),
    },
    onSpawnForTest: (child) => {
      const state: TrackedChild = {
        child,
        stdout: "",
        stderr: "",
        exitCode: null,
        signal: null,
        closed: false,
      };
      tracked.push(state);
      child.stdout?.on("data", (chunk: Buffer) => { state.stdout += chunk.toString("utf8"); });
      child.stderr?.on("data", (chunk: Buffer) => { state.stderr += chunk.toString("utf8"); });
      child.on("error", (error) => { state.error = error.message; });
      child.on("exit", (code, signal) => {
        state.exitCode = code;
        state.signal = signal;
      });
      child.on("close", () => { state.closed = true; });
    },
    marker,
    exists,
    read: (name) => fs.readFileSync(marker(name), "utf8"),
    exitCode: (identity) => {
      const evidence = JSON.parse(fs.readFileSync(marker(`${identity}.done`), "utf8")) as { exitCode: number };
      return evidence.exitCode;
    },
    release: (...identities) => {
      if (!fs.existsSync(dir)) return;
      for (const identity of identities) fs.writeFileSync(marker(`${identity}.release`), "release\n");
    },
    waitFor: (names, description, timeoutMs = 8_000) =>
      waitUntil({
        description,
        predicate: () => names.every(exists),
        describeObserved: () => fixture.describe(),
        timeoutMs,
      }),
    spawnedChildren: () => tracked.map((state) => state.child),
    isClosed: (child) => stateFor(child)?.closed ?? false,
    waitForAllClosed: (description = "tracked hook processes to close") =>
      waitUntil({
        description,
        predicate: () => tracked.every((state) => state.closed),
        describeObserved: () => fixture.describe(),
        timeoutMs: 5_000,
      }),
    describe: () => {
      const entries = fs.existsSync(dir) ? fs.readdirSync(dir).sort() : ["<directory removed>"];
      const markerState = Object.fromEntries(entries
        .filter((entry) => entry !== "hook child.mjs" && !entry.endsWith(".tmp"))
        .map((entry) => {
          try {
            return [entry, fs.readFileSync(marker(entry), "utf8")];
          } catch (error) {
            return [entry, `<unreadable: ${String(error)}>`];
          }
        }));
      const processState = tracked.map((state) => ({
        pid: state.child.pid,
        closed: state.closed,
        exitCode: state.exitCode,
        signal: state.signal,
        error: state.error,
        stdout: state.stdout,
        stderr: state.stderr,
      }));
      return `barrier=${dir}; command=${fixture.command}; processes=${JSON.stringify(processState)}; markers=${JSON.stringify(markerState)}`;
    },
    cleanup: async (...identitiesToRelease) => {
      fixture.release(...identitiesToRelease);
      for (const state of tracked) {
        if (state.closed) continue;
        if (process.platform === "win32" && state.child.pid) {
          spawnSync("taskkill", ["/pid", String(state.child.pid), "/T", "/F"], {
            stdio: "ignore",
            windowsHide: true,
            timeout: 3_000,
          });
        } else {
          try {
            state.child.kill("SIGKILL");
          } catch {
            // It closed between the state check and the signal.
          }
        }
      }
      await fixture.waitForAllClosed("tracked hook process cleanup");
      fs.rmSync(dir, { recursive: true });
    },
  };
  return fixture;
}

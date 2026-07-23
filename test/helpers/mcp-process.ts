import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { waitUntil } from "./async.js";

/**
 * Test fixture around `mcp-stdio-server.mjs`, mirroring `HookProcessFixture`:
 * a barrier directory for the marker/release protocol, spawn parameters for
 * the fixture server, and a cleanup that kills every published server pid
 * (taskkill fallback on Windows) — cleanup in `finally`/`afterEach` is
 * non-negotiable, stray node processes are the CI flake vector.
 *
 * Unlike hooks, the MCP runtime owns the ChildProcess (inside the SDK
 * transport), so tracking is via the pid markers the fixture publishes
 * (`<mode>.pid`, `grandchild.pid`), not via a spawn observer.
 */
export interface McpProcessFixture {
  /** Barrier directory (also spawn cwd-independent marker root). */
  readonly dir: string;
  /** Absolute path of the committed fixture server module. */
  readonly serverScript: string;
  /** Command for a ResolvedMcpServer: the running node binary. */
  readonly nodeCommand: string;
  /** Env to merge into the server entry's `env` so markers land in `dir`. */
  readonly env: Record<string, string>;
  marker(name: string): string;
  exists(name: string): boolean;
  read(name: string): string;
  /** Parse the pid out of a published `*.pid` / `*.entered` marker. */
  pidOf(markerName: string): number;
  release(...identities: string[]): void;
  waitFor(names: string[], description: string, timeoutMs?: number): Promise<void>;
  /** Every pid published so far (all `*.pid` markers). */
  publishedPids(): number[];
  describe(): string;
  /** Release the given identities, kill every published pid, await death, remove the dir. */
  cleanup(...identitiesToRelease: string[]): Promise<void>;
}

export function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function createMcpProcessFixture(parentDir: string): McpProcessFixture {
  // Deliberately shell-hostile path, as with the hook fixture: server args and
  // env must survive spaces and quote characters.
  const dir = path.join(parentDir, "mcp fixture space's dir");
  fs.mkdirSync(dir, { recursive: true });
  const serverScript = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "mcp-stdio-server.mjs",
  );
  const marker = (name: string) => path.join(dir, name);
  const exists = (name: string) => fs.existsSync(marker(name));

  const fixture: McpProcessFixture = {
    dir,
    serverScript,
    nodeCommand: process.execPath,
    env: { MCP_BARRIER_DIR: dir },
    marker,
    exists,
    read: (name) => fs.readFileSync(marker(name), "utf8"),
    pidOf: (markerName) => {
      const evidence = JSON.parse(fs.readFileSync(marker(markerName), "utf8")) as { pid: number };
      return evidence.pid;
    },
    release: (...identities) => {
      if (!fs.existsSync(dir)) return;
      for (const identity of identities) {
        fs.writeFileSync(marker(`${identity}.release`), "release\n");
      }
    },
    waitFor: (names, description, timeoutMs = 8_000) =>
      waitUntil({
        description,
        predicate: () => names.every(exists),
        describeObserved: () => fixture.describe(),
        timeoutMs,
      }),
    publishedPids: () => {
      if (!fs.existsSync(dir)) return [];
      const pids: number[] = [];
      for (const entry of fs.readdirSync(dir)) {
        if (!entry.endsWith(".pid")) continue;
        try {
          pids.push(fixture.pidOf(entry));
        } catch {
          /* half-written marker; the atomic rename makes this unlikely */
        }
      }
      return pids;
    },
    describe: () => {
      const entries = fs.existsSync(dir) ? fs.readdirSync(dir).sort() : ["<directory removed>"];
      const markerState = Object.fromEntries(
        entries
          .filter((entry) => !entry.endsWith(".tmp"))
          .map((entry) => {
            try {
              return [entry, fs.readFileSync(marker(entry), "utf8")];
            } catch (error) {
              return [entry, `<unreadable: ${String(error)}>`];
            }
          }),
      );
      return `barrier=${dir}; markers=${JSON.stringify(markerState)}`;
    },
    cleanup: async (...identitiesToRelease) => {
      fixture.release(...identitiesToRelease);
      const pids = fixture.publishedPids();
      for (const pid of pids) {
        if (!processIsAlive(pid)) continue;
        if (process.platform === "win32") {
          spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], {
            stdio: "ignore",
            windowsHide: true,
            timeout: 3_000,
          });
        } else {
          try {
            process.kill(pid, "SIGKILL");
          } catch {
            /* died between the aliveness check and the signal */
          }
        }
      }
      await waitUntil({
        description: "published MCP fixture processes to die",
        predicate: () => pids.every((pid) => !processIsAlive(pid)),
        describeObserved: () =>
          `alive=${pids.filter(processIsAlive).join(",")}; ${fixture.describe()}`,
        timeoutMs: 5_000,
      });
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
  return fixture;
}

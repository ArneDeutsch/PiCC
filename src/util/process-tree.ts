import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import path from "node:path";
import { sanitizedSubprocessEnv } from "./env.js";

export function processTreeSpawnEnv(
  inherited: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return sanitizedSubprocessEnv(inherited);
}

/** Trusted native executable path; never resolve taskkill through a project cwd. */
export function windowsTaskkillPath(inherited: NodeJS.ProcessEnv = process.env): string {
  const configured = inherited.SystemRoot ?? inherited.SYSTEMROOT;
  const root = configured && path.win32.isAbsolute(configured) ? configured : "C:\\Windows";
  return path.win32.join(root, "System32", "taskkill.exe");
}

/**
 * Process-tree kill helpers shared by the hook runner (timed-out hook
 * children) and the MCP runtime (long-lived stdio servers). Every function
 * here is best-effort and never throws: killing is always a degrade path,
 * and a kill failure must never take the session down with it.
 */

/** Kill a child process and its children; never throws. */
export function killProcessTree(child: ChildProcess): void {
  try {
    if (process.platform === "win32" && child.pid) {
      // taskkill /T kills the whole tree (bash + whatever it spawned).
      const killer = spawn(windowsTaskkillPath(), ["/pid", String(child.pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
        env: processTreeSpawnEnv(),
      });
      killer.on("error", () => {
        try {
          child.kill("SIGKILL");
        } catch {
          /* already gone */
        }
      });
      killer.unref();
      return;
    }
  } catch {
    /* fall through to plain kill */
  }
  try {
    child.kill("SIGKILL");
  } catch {
    /* already gone */
  }
}

/**
 * Kill a process tree by pid alone — for children we did not spawn ourselves
 * (the MCP SDK's stdio transport owns its `ChildProcess` and exposes only the
 * pid). Windows delegates the tree walk to `taskkill /T`; POSIX has no
 * tree-kill syscall for a process outside our own group, so descendants are
 * snapshotted via `ps` first and then killed parent-first (parent first so a
 * supervising parent cannot respawn children into a stale snapshot).
 * Never throws.
 */
export function killProcessTreeByPid(pid: number): void {
  try {
    if (process.platform === "win32") {
      const killer = spawn(windowsTaskkillPath(), ["/pid", String(pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
        env: processTreeSpawnEnv(),
      });
      killer.on("error", () => killPidBestEffort(pid));
      killer.unref();
      return;
    }
  } catch {
    /* fall through to the POSIX path */
  }
  for (const target of [pid, ...listDescendantPids(pid)]) {
    killPidBestEffort(target);
  }
}

interface AwaitedTreeKillChild {
  once(event: "error", listener: () => void): this;
  once(event: "close", listener: (code: number | null) => void): this;
  kill(): boolean;
  unref(): void;
}

export interface AwaitedTreeKillIo {
  platform: NodeJS.Platform;
  taskkillPath: string;
  spawnTaskkill(command: string, args: readonly string[]): AwaitedTreeKillChild;
}

function defaultAwaitedTreeKillIo(): AwaitedTreeKillIo {
  return {
    platform: process.platform,
    taskkillPath: windowsTaskkillPath(),
    spawnTaskkill: (command, args) => spawn(command, args, {
      stdio: "ignore",
      windowsHide: true,
      env: processTreeSpawnEnv(),
    }),
  };
}

/**
 * Kill a process tree and wait until the platform tree-kill operation settles.
 *
 * Windows callers that immediately kill the root after starting `taskkill /T`
 * can win the race against taskkill's descendant discovery and strand the
 * descendants. A `true` result proves taskkill completed successfully. Failure
 * paths remain explicitly uncertain and leave the root intact so a later tree
 * traversal can still discover its descendants.
 */
export function killProcessTreeByPidAndWait(
  pid: number,
  maxWaitMs: number,
  io: AwaitedTreeKillIo = defaultAwaitedTreeKillIo(),
): Promise<boolean> {
  if (io.platform !== "win32") {
    killProcessTreeByPid(pid);
    return Promise.resolve(true);
  }
  if (maxWaitMs <= 0) return Promise.resolve(false);

  return new Promise((resolve) => {
    let settled = false;
    let killer: AwaitedTreeKillChild | undefined;
    let timer: NodeJS.Timeout | undefined;
    const finish = (completed: boolean): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(completed);
    };

    try {
      killer = io.spawnTaskkill(io.taskkillPath, ["/pid", String(pid), "/T", "/F"]);
      killer.once("error", () => finish(false));
      killer.once("close", (code) => finish(code === 0));
      timer = setTimeout(() => {
        try {
          killer?.kill();
          killer?.unref();
        } catch {
          /* taskkill already settled */
        }
        finish(false);
      }, maxWaitMs);
    } catch {
      finish(false);
    }
  });
}

function killPidBestEffort(pid: number): void {
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    /* already gone */
  }
}

/**
 * Snapshot the live descendant pids of `pid` (children, grandchildren, …).
 *
 * POSIX only — on win32 this returns `[]` because `taskkill /T` walks the tree
 * itself and the wmic/CIM alternatives are slow and deprecated. The snapshot
 * exists for the "graceful close first" shutdown ordering: once the direct
 * child exits, its children reparent to init and no later tree walk can find
 * them, so callers snapshot BEFORE closing and sweep the snapshot AFTER.
 * Best-effort: any `ps` failure degrades to `[]`; never throws.
 */
export function listDescendantPids(pid: number): number[] {
  if (process.platform === "win32") return [];
  try {
    const out = spawnSync("ps", ["-Ao", "pid=,ppid="], {
      encoding: "utf8",
      timeout: 2_000,
      windowsHide: true,
      env: processTreeSpawnEnv(),
    });
    if (typeof out.stdout !== "string") return [];
    const childrenOf = new Map<number, number[]>();
    for (const line of out.stdout.split("\n")) {
      const match = line.trim().match(/^(\d+)\s+(\d+)$/);
      if (!match) continue;
      const child = Number(match[1]);
      const parent = Number(match[2]);
      const siblings = childrenOf.get(parent);
      if (siblings) siblings.push(child);
      else childrenOf.set(parent, [child]);
    }
    const result: number[] = [];
    const seen = new Set<number>([pid]);
    const queue = [pid];
    while (queue.length > 0) {
      const current = queue.shift()!;
      for (const child of childrenOf.get(current) ?? []) {
        if (seen.has(child)) continue;
        seen.add(child);
        result.push(child);
        queue.push(child);
      }
    }
    return result;
  } catch {
    return [];
  }
}

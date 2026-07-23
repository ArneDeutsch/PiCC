import { spawn, spawnSync, type ChildProcess } from "node:child_process";

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
      const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
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
      const killer = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
      killer.on("error", () => {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          /* already gone */
        }
      });
      killer.unref();
      return;
    }
  } catch {
    /* fall through to the POSIX path */
  }
  for (const target of [pid, ...listDescendantPids(pid)]) {
    try {
      process.kill(target, "SIGKILL");
    } catch {
      /* already gone */
    }
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

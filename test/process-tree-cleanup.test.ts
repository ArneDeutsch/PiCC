import { spawn } from "node:child_process";
import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { settlement, waitUntil } from "./helpers/async.js";
import { stopProcessTree } from "./helpers/e2e-live.js";

function processIsLive(pid: number): boolean {
  if (process.platform === "linux") {
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
      const commandEnd = stat.lastIndexOf(")");
      if (commandEnd >= 0) {
        const state = stat.slice(commandEnd + 1).trimStart().charAt(0);
        if (state === "Z") return false;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    }
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function waitForExit(pid: number, description: string): Promise<void> {
  await waitUntil({ description, timeoutMs: 8_000, predicate: () => !processIsLive(pid) });
}

describe("process-tree cleanup", () => {
  it("forcibly stops a ready local parent and descendant through the platform tree branch", async () => {
    const descendantSource = [
      "process.send?.({ type: 'ready' });",
      "process.on('message', (message) => { if (message === 'release') process.exit(0); });",
    ].join("\n");
    const parentSource = [
      "const { spawn } = require('node:child_process');",
      `const descendant = spawn(${JSON.stringify(process.execPath)}, ['-e', ${JSON.stringify(descendantSource)}], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });`,
      "let ready = false;",
      "descendant.once('error', (error) => { process.send?.({ type: 'descendant-error', message: error.message }); process.exit(1); });",
      "descendant.once('close', (code, signal) => { process.send?.({ type: 'descendant-close', code, signal, beforeReady: !ready }); });",
      "descendant.once('message', (message) => { if (message?.type !== 'ready') return; ready = true; process.send?.({ type: 'ready', descendantPid: descendant.pid }); });",
      "process.on('message', (message) => { if (message !== 'release') return; descendant.send?.('release'); descendant.once('close', () => process.exit(0)); });",
    ].join("\n");
    const parent = spawn(process.execPath, ["-e", parentSource], {
      detached: process.platform !== "win32",
      stdio: ["ignore", "ignore", "ignore", "ipc"],
      windowsHide: true,
    });
    const parentPid = parent.pid;
    const closed = new Promise<number | null>((resolve) => parent.once("close", resolve));
    const ready = new Promise<number>((resolve, reject) => {
      parent.once("error", reject);
      parent.on("message", (message: unknown) => {
        if (!message || typeof message !== "object") return;
        const report = message as { type?: unknown; message?: unknown; descendantPid?: unknown; beforeReady?: unknown };
        if (report.type === "descendant-error") {
          reject(new Error(String(report.message ?? "descendant spawn failed")));
        } else if (report.type === "descendant-close" && report.beforeReady === true) {
          reject(new Error("Descendant closed before readiness"));
        } else if (report.type === "ready" && typeof report.descendantPid === "number") {
          resolve(report.descendantPid);
        }
      });
      parent.once("close", (code) => reject(new Error(`Parent closed before readiness (${code ?? "signal"})`)));
    });
    let descendantPid: number | undefined;
    let cleanupError: unknown;
    try {
      await settlement(ready, { description: "local process tree readiness", timeoutMs: 8_000 });
      descendantPid = await ready;
      expect(parentPid).toEqual(expect.any(Number));
      expect(processIsLive(parentPid!)).toBe(true);
      expect(processIsLive(descendantPid)).toBe(true);

      await stopProcessTree(parent, closed);
      await waitForExit(descendantPid, "forced descendant termination");
      expect(processIsLive(parentPid!)).toBe(false);
    } finally {
      try { parent.send?.("release"); } catch { /* forced cleanup may already have closed IPC */ }
      if (parentPid !== undefined && processIsLive(parentPid)) {
        try {
          await stopProcessTree(parent, closed);
        } catch (error) {
          cleanupError = error;
        }
      }
      if (parentPid !== undefined && processIsLive(parentPid)) {
        try {
          process.kill(process.platform === "win32" ? parentPid : -parentPid, "SIGKILL");
          await waitForExit(parentPid, "fallback parent termination");
        } catch (error) {
          cleanupError ??= error;
        }
      }
      if (descendantPid !== undefined && processIsLive(descendantPid)) {
        try {
          process.kill(descendantPid, "SIGKILL");
          await waitForExit(descendantPid, "fallback descendant termination");
        } catch (error) {
          cleanupError ??= error;
        }
      }
      if (!cleanupError) {
        await settlement(closed, { description: "local parent close", timeoutMs: 8_000 });
        await closed;
      }
      if (cleanupError) throw cleanupError;
    }
  });
});

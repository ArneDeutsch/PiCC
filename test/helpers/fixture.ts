import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * Copy an examples/ fixture into a temp dir and turn it into a real git repo.
 *
 * Built directly (not from a cached template) on purpose: most consumers call
 * this exactly once per process (a `beforeAll`), where a build-once/copy-per-test
 * template is pure overhead — the process pays the template build AND a copy,
 * ~2x the work, which pushed the slowest CI leg (windows/node-24) past the 30s
 * hook timeout. The multi-call hot path that a template genuinely helps is the
 * git-repo shape in ./git-repo.ts (worktrees.test.ts calls it ~24x per process).
 */
export function materializeFixture(name: string): string {
  const src = path.join(REPO_ROOT, "examples", name);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `pcd-fixture-`));
  fs.cpSync(src, dir, { recursive: true });
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
  git("init", "-b", "main");
  git("config", "user.email", "test@picc.local");
  git("config", "user.name", "PiCC Test");
  git("config", "core.autocrlf", "false");
  git("add", "-A");
  git("commit", "-m", "fixture baseline", "--no-gpg-sign");
  return dir;
}

export function cleanupFixture(dir: string): void {
  try {
    // Remove worktrees first so the main dir unlinks cleanly on Windows.
    try {
      execFileSync("git", ["worktree", "prune"], { cwd: dir });
    } catch {
      /* ignore */
    }
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    /* temp dirs are reaped by the OS eventually */
  }
}

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Build-once/copy-per-test template for the standalone repo shape used by
 * `test/worktrees.test.ts`'s `makeRepo`.
 *
 * A standalone `git init` repo stores no absolute path to its own location, so
 * `fs.cpSync` yields a byte-identical, fully functional repo at any new path.
 * The template is built lazily into its OWN `mkdtempSync` dir (unique per
 * process, so `pool: "forks"` never lets two forks race the same git build) and
 * memoized at module level. All git calls are synchronous and fully returned
 * before the first copy, so no `.git/index.lock` can be copied into a consumer.
 * The builder never runs `git worktree add`, so the template is always a
 * standalone repo (safe to copy).
 */

let repoTemplate: string | undefined;

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
}

function buildRepoTemplate(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pcd-wt-tmpl-"));
  git(dir, "init");
  git(dir, "config", "user.email", "test@example.com");
  git(dir, "config", "user.name", "PiCC Test");
  git(dir, "config", "commit.gpgsign", "false");
  git(dir, "config", "core.autocrlf", "false");
  fs.writeFileSync(path.join(dir, "README.md"), "hello\n", "utf8");
  git(dir, "add", "-A");
  git(dir, "commit", "-m", "init");
  git(dir, "branch", "-M", "main");
  return dir;
}

/**
 * Materialize a fresh, independent copy of the standalone-repo template.
 * `realpathSync.native` is applied to the FRESH COPY (not the cached template)
 * because worktree path-equality assertions depend on the resolved path.
 */
export function makeRepoFromTemplate(): string {
  repoTemplate ??= buildRepoTemplate();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pcd-wt-"));
  fs.cpSync(repoTemplate, dir, { recursive: true });
  return fs.realpathSync.native(dir);
}

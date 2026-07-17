import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * Build-once/copy-per-test templates for the examples/ fixture repo shape,
 * keyed by fixture name. Each template is a standalone git repo built lazily
 * into its OWN `mkdtempSync` dir (unique per process, so `pool: "forks"` never
 * lets two forks race the same git build) and memoized at module level. All git
 * calls are synchronous and fully returned before the first copy, so no
 * `.git/index.lock` can be copied into a consumer.
 */
const fixtureTemplates = new Map<string, string>();

function buildFixtureTemplate(name: string): string {
  const src = path.join(REPO_ROOT, "examples", name);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `pcd-fixture-tmpl-`));
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

/** Copy an examples/ fixture into a temp dir and turn it into a real git repo. */
export function materializeFixture(name: string): string {
  let template = fixtureTemplates.get(name);
  if (template === undefined) {
    template = buildFixtureTemplate(name);
    fixtureTemplates.set(name, template);
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `pcd-fixture-`));
  fs.cpSync(template, dir, { recursive: true });
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

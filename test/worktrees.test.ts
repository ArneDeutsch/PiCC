import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  WorktreeManager,
  flattenWorktreeName,
  type WorktreeReapFailureCategory,
} from "../src/runtime/worktrees.js";
import type { WorktreeSettings } from "../src/types.js";
import { makeRepoFromTemplate } from "./helpers/git-repo.js";

const tempDirs: string[] = [];
const children: ChildProcess[] = [];

function failureCounts(
  changed?: Partial<Record<WorktreeReapFailureCategory, number>>,
): Record<WorktreeReapFailureCategory, number> {
  return {
    "settings-blocked": 0,
    "git-authority": 0,
    permission: 0,
    busy: 0,
    "other-io": 0,
    ...changed,
  };
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true }).trim();
}

function makeRepo(): string {
  const dir = makeRepoFromTemplate();
  tempDirs.push(dir);
  return dir;
}

function makeManager(
  projectRoot: string,
  settings: WorktreeSettings = { baseRef: "head" },
  extra: { cleanupPeriodDays?: number; retentionCleanupAllowed?: boolean } = {},
): WorktreeManager {
  return new WorktreeManager({ projectRoot, settings, ...extra });
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, 3000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill();
  });
}

afterEach(async () => {
  vi.useRealTimers();
  while (children.length > 0) {
    const child = children.pop()!;
    try {
      await stopChild(child);
    } catch {
      // best-effort
    }
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
      // best-effort cleanup (Windows can hold handles briefly)
    }
  }
});

describe("WorktreeManager.enter (name mode)", () => {
  it("creates .claude/worktrees/<flat> on branch worktree-<flat> with the pre-create HEAD recorded", async () => {
    const repo = makeRepo();
    // Second commit so HEAD is distinguishable from the root commit.
    fs.writeFileSync(path.join(repo, "second.txt"), "2\n", "utf8");
    git(repo, "add", "-A");
    git(repo, "commit", "-m", "second");
    const headBefore = git(repo, "rev-parse", "HEAD");

    const mgr = makeManager(repo);
    const res = await mgr.enter({ name: "feat1" });

    expect(res.ok).toBe(true);
    expect(res.created).toBe(true);
    expect(res.error).toBeUndefined();
    expect(res.branch).toBe("worktree-feat1");
    expect(res.baseCommit).toBe(headBefore);
    const expectedDir = path.join(repo, ".claude", "worktrees", "feat1");
    expect(path.resolve(res.worktreePath!)).toBe(expectedDir);

    // Linked worktree: .git is a pointer file, HEAD is the base commit.
    expect(fs.statSync(path.join(expectedDir, ".git")).isFile()).toBe(true);
    expect(git(expectedDir, "rev-parse", "HEAD")).toBe(headBefore);
    expect(git(expectedDir, "rev-parse", "--abbrev-ref", "HEAD")).toBe("worktree-feat1");

    // base-commit file records the pre-create HEAD, newline-terminated.
    const baseFile = path.join(expectedDir, ".claude", ".picc", "base-commit");
    expect(fs.readFileSync(baseFile, "utf8")).toBe(`${headBefore}\n`);

    // Active worktree is locked against concurrent cleanup.
    const listed = await mgr.list();
    const entry = listed.find((e) => path.resolve(e.path) === expectedDir);
    expect(entry).toBeDefined();
    expect(entry!.locked).toBe(true);
  });

  it("flattens names: feature/x -> feature-x dir, worktree-feature-x branch", async () => {
    expect(flattenWorktreeName("feature/x")).toBe("feature-x");
    expect(flattenWorktreeName("Feature/X")).toBe("feature-x");

    const repo = makeRepo();
    const mgr = makeManager(repo);
    const res = await mgr.enter({ name: "feature/x" });
    expect(res.ok).toBe(true);
    expect(res.branch).toBe("worktree-feature-x");
    expect(path.resolve(res.worktreePath!)).toBe(path.join(repo, ".claude", "worktrees", "feature-x"));
  });

  it("rejects both/none of name and path as an error result (no throw)", async () => {
    const repo = makeRepo();
    const mgr = makeManager(repo);

    const neither = await mgr.enter({});
    expect(neither.ok).toBe(false);
    expect(neither.error).toMatch(/mutually exclusive/);

    const both = await mgr.enter({ name: "x", path: repo });
    expect(both.ok).toBe(false);
    expect(both.error).toMatch(/mutually exclusive/);
  });

  it("reuses an existing worktree dir for the same name (created: false, no seeding)", async () => {
    const repo = makeRepo();
    const mgr = makeManager(repo);
    const first = await mgr.enter({ name: "again" });
    expect(first.created).toBe(true);

    const second = await mgr.enter({ name: "again" });
    expect(second.ok).toBe(true);
    expect(second.created).toBe(false);
    expect(second.worktreePath).toBe(first.worktreePath);
    expect(second.branch).toBe("worktree-again");
    expect(second.baseCommit).toBe(first.baseCommit);
    expect(second.seededFiles).toEqual([]);
  });

  it('baseRef "fresh" without a remote falls back to HEAD with a diagnostic', async () => {
    const repo = makeRepo();
    const head = git(repo, "rev-parse", "HEAD");
    const mgr = makeManager(repo, { baseRef: "fresh" });
    const res = await mgr.enter({ name: "fresh1" });
    expect(res.ok).toBe(true);
    expect(res.baseCommit).toBe(head);
    expect(res.diagnostics.some((d) => /fresh/.test(d.message))).toBe(true);
  });

  it("suffixes the branch when worktree-<flat> is checked out elsewhere, reuses a free leftover branch", async () => {
    const repo = makeRepo();
    // In use: checked out in the main worktree.
    git(repo, "checkout", "-b", "worktree-feat");
    const mgr = makeManager(repo);
    const res = await mgr.enter({ name: "feat" });
    expect(res.ok).toBe(true);
    expect(res.branch).toBe("worktree-feat-2");
    expect(path.resolve(res.worktreePath!)).toBe(path.join(repo, ".claude", "worktrees", "feat"));

    // Free leftover branch (exists, not checked out anywhere) -> reused.
    git(repo, "branch", "worktree-leftover");
    const reuse = await mgr.enter({ name: "leftover" });
    expect(reuse.ok).toBe(true);
    expect(reuse.created).toBe(true);
    expect(reuse.branch).toBe("worktree-leftover");
    expect(git(reuse.worktreePath!, "rev-parse", "--abbrev-ref", "HEAD")).toBe("worktree-leftover");
  });

  it("reuses a diverged leftover branch at its tip and records the merge-base, not the resolved base", async () => {
    const repo = makeRepo();
    const fork = git(repo, "rev-parse", "HEAD");

    // Leftover branch with unmerged work of its own.
    git(repo, "checkout", "-b", "worktree-stale");
    fs.writeFileSync(path.join(repo, "wip.txt"), "wip\n", "utf8");
    git(repo, "add", "-A");
    git(repo, "commit", "-m", "stale wip");
    const staleTip = git(repo, "rev-parse", "HEAD");

    // Main advances past the fork point.
    git(repo, "checkout", "main");
    fs.writeFileSync(path.join(repo, "main2.txt"), "2\n", "utf8");
    git(repo, "add", "-A");
    git(repo, "commit", "-m", "main advances");
    const newHead = git(repo, "rev-parse", "HEAD");

    const mgr = makeManager(repo);
    const res = await mgr.enter({ name: "stale" });
    expect(res.ok).toBe(true);
    expect(res.branch).toBe("worktree-stale");
    // Checkout preserves the branch's unmerged work (never reset).
    expect(git(res.worktreePath!, "rev-parse", "HEAD")).toBe(staleTip);
    // Recorded base = where the branch diverged, so base..HEAD is the unit of work.
    expect(res.baseCommit).toBe(fork);
    expect(res.baseCommit).not.toBe(newHead);
    const baseFile = path.join(res.worktreePath!, ".claude", ".picc", "base-commit");
    expect(fs.readFileSync(baseFile, "utf8")).toBe(`${fork}\n`);
  });

  it("reaps an orphaned non-worktree dir with the same name and recreates a real worktree", async () => {
    const repo = makeRepo();
    const mgr = makeManager(repo);

    // Shape left behind by a partially failed removal: dir exists, .git pointer
    // severed, not registered. Old code adopted it (created:false, branch undefined)
    // and the session's git context silently became the MAIN repo.
    const orphan = path.join(repo, ".claude", "worktrees", "zomb");
    fs.mkdirSync(path.join(orphan, "leftover"), { recursive: true });
    fs.writeFileSync(path.join(orphan, "leftover", "junk.txt"), "x\n", "utf8");

    const res = await mgr.enter({ name: "zomb" });
    expect(res.ok).toBe(true);
    expect(res.created).toBe(true);
    expect(res.branch).toBe("worktree-zomb");
    expect(res.diagnostics.some((d) => /not a registered worktree/.test(d.message))).toBe(true);
    // A real linked worktree now: .git pointer file, no stale junk.
    expect(fs.statSync(path.join(orphan, ".git")).isFile()).toBe(true);
    expect(fs.existsSync(path.join(orphan, "leftover"))).toBe(false);
    expect(git(orphan, "rev-parse", "--abbrev-ref", "HEAD")).toBe("worktree-zomb");
  });
});

describe("WorktreeManager.enter (path mode)", () => {
  it("re-enters an existing worktree without creating or seeding anything", async () => {
    const repo = makeRepo();
    const head = git(repo, "rev-parse", "HEAD");
    // Seeding config present — must NOT re-seed on path re-entry.
    fs.writeFileSync(path.join(repo, ".gitignore"), ".env.local\n", "utf8");
    fs.writeFileSync(path.join(repo, ".env.local"), "SECRET=1\n", "utf8");
    fs.writeFileSync(path.join(repo, ".worktreeinclude"), ".env.local\n", "utf8");
    const mgr = makeManager(repo);
    const created = await mgr.enter({ name: "resume" });
    expect(created.ok).toBe(true);

    const seedTarget = path.join(created.worktreePath!, ".env.local");
    fs.rmSync(seedTarget); // prove re-entry does not recreate it

    const re = await mgr.enter({ path: created.worktreePath! });
    expect(re.ok).toBe(true);
    expect(re.created).toBe(false);
    expect(re.seededFiles).toEqual([]);
    expect(re.branch).toBe("worktree-resume");
    expect(re.baseCommit).toBe(head);
    expect(fs.existsSync(seedTarget)).toBe(false);
  });

  it("rejects a path that is not a registered worktree", async () => {
    const repo = makeRepo();
    const mgr = makeManager(repo);

    const missing = await mgr.enter({ path: path.join(repo, "does-not-exist") });
    expect(missing.ok).toBe(false);
    expect(missing.error).toMatch(/not an existing directory/);

    // Outside .claude/worktrees -> containment rejection.
    const plainDir = path.join(repo, "plain");
    fs.mkdirSync(plainDir);
    const notWorktree = await mgr.enter({ path: plainDir });
    expect(notWorktree.ok).toBe(false);
    expect(notWorktree.error).toMatch(/outside/);

    // Inside .claude/worktrees but never registered -> worktree rejection.
    const containedDir = path.join(repo, ".claude", "worktrees", "fake");
    fs.mkdirSync(containedDir, { recursive: true });
    const contained = await mgr.enter({ path: containedDir });
    expect(contained.ok).toBe(false);
    expect(contained.error).toMatch(/not a registered git worktree/);
  });

  it("rejects the main working tree and any linked worktree outside .claude/worktrees", async () => {
    const repo = makeRepo();
    const mgr = makeManager(repo);

    // The main working tree IS listed by `git worktree list` — must still be rejected.
    const main = await mgr.enter({ path: repo });
    expect(main.ok).toBe(false);
    expect(main.error).toMatch(/main working tree/);

    // A genuine linked worktree outside the managed root is not ours to manage.
    const sideDir = path.join(repo, "side-wt");
    git(repo, "worktree", "add", "-b", "side-branch", sideDir);
    const side = await mgr.enter({ path: sideDir });
    expect(side.ok).toBe(false);
    expect(side.error).toMatch(/outside/);
  });

  it("treats failed worktree listing as no authority to adopt, reap, or remove", async () => {
    const repo = makeRepo();
    const managedRoot = path.join(repo, ".claude", "worktrees");
    const pointed = path.join(managedRoot, "pointed");
    const orphan = path.join(managedRoot, "orphan");
    fs.mkdirSync(pointed, { recursive: true });
    fs.writeFileSync(path.join(pointed, ".git"), "gitdir: unavailable\n", "utf8");
    fs.mkdirSync(orphan);
    fs.writeFileSync(path.join(orphan, "keep.txt"), "keep\n", "utf8");
    const calls: string[][] = [];
    const mgr = new WorktreeManager({
      projectRoot: repo,
      settings: { baseRef: "head" },
      exec: async (_cmd, args) => {
        calls.push(args);
        return { stdout: "", stderr: "git unavailable", code: 1 };
      },
    });

    const byPath = await mgr.enter({ path: pointed });
    expect(byPath.ok).toBe(false);
    expect(byPath.error).toMatch(/cannot verify path/);

    const byName = await mgr.enter({ name: "orphan" });
    expect(byName.ok).toBe(false);
    expect(fs.readFileSync(path.join(orphan, "keep.txt"), "utf8")).toBe("keep\n");

    const reaped = await mgr.reapOrphans();
    expect(reaped.reaped).toEqual([]);
    expect(reaped.retainedWorktrees).toBe(0);
    expect(reaped.failureCounts).toEqual(failureCounts({ "git-authority": 1 }));
    expect(fs.existsSync(orphan)).toBe(true);

    const removed = await mgr.exit({ worktreePath: pointed, action: "remove" });
    expect(removed.ok).toBe(false);
    expect(fs.existsSync(pointed)).toBe(true);
    expect(calls.some((args) => args[0] === "worktree" && ["unlock", "remove", "prune"].includes(args[1] ?? ""))).toBe(false);
    expect(calls.some((args) => args[0] === "branch")).toBe(false);
  });
});

describe(".worktreeinclude seeding", () => {
  it("copies gitignored files matching the globs into a new worktree", async () => {
    const repo = makeRepo();
    fs.writeFileSync(path.join(repo, ".gitignore"), ".env.local\n*.secret\n", "utf8");
    git(repo, "add", ".gitignore");
    git(repo, "commit", "-m", "gitignore");
    fs.writeFileSync(path.join(repo, ".env.local"), "SECRET=1\n", "utf8");
    fs.mkdirSync(path.join(repo, "config"));
    fs.writeFileSync(path.join(repo, "config", "x.secret"), "token\n", "utf8");
    // Tracked file matching a pattern must NOT be seeded (not gitignored).
    fs.writeFileSync(
      path.join(repo, ".worktreeinclude"),
      "# local files needed for builds\n.env.local\nconfig/*.secret\nREADME.md\n",
      "utf8",
    );

    const mgr = makeManager(repo);
    const res = await mgr.enter({ name: "seeded" });
    expect(res.ok).toBe(true);
    expect(res.seededFiles).toEqual([".env.local", "config/x.secret"]);
    expect(fs.readFileSync(path.join(res.worktreePath!, ".env.local"), "utf8")).toBe("SECRET=1\n");
    expect(fs.readFileSync(path.join(res.worktreePath!, "config", "x.secret"), "utf8")).toBe("token\n");
  });

  it("honors gitignore-style negation lines: later `!pattern` un-matches earlier matches", async () => {
    const repo = makeRepo();
    fs.writeFileSync(path.join(repo, ".gitignore"), ".env*\nsecret.txt\n", "utf8");
    fs.writeFileSync(path.join(repo, ".env.local"), "SECRET=1\n", "utf8");
    fs.writeFileSync(path.join(repo, ".env.example"), "SECRET=\n", "utf8");
    fs.writeFileSync(path.join(repo, "secret.txt"), "s\n", "utf8");
    fs.writeFileSync(path.join(repo, ".worktreeinclude"), ".env*\n!.env.example\n", "utf8");

    const mgr = makeManager(repo);
    const res = await mgr.enter({ name: "negated" });
    expect(res.ok).toBe(true);
    // Old code: picomatch inverted `!.env.example` into a match-everything
    // pattern, so secret.txt (and every other gitignored file) got seeded too.
    expect(res.seededFiles).toEqual([".env.local"]);
    expect(fs.existsSync(path.join(res.worktreePath!, ".env.example"))).toBe(false);
    expect(fs.existsSync(path.join(res.worktreePath!, "secret.txt"))).toBe(false);
  });

  it("seeds nothing when .worktreeinclude contains only negation lines", async () => {
    const repo = makeRepo();
    fs.writeFileSync(path.join(repo, ".gitignore"), "*.log\n", "utf8");
    fs.writeFileSync(path.join(repo, "debug.log"), "x\n", "utf8");
    fs.writeFileSync(path.join(repo, ".worktreeinclude"), "!prod.env\n", "utf8");

    const mgr = makeManager(repo);
    const res = await mgr.enter({ name: "neg-only" });
    expect(res.ok).toBe(true);
    expect(res.seededFiles).toEqual([]);
    expect(fs.existsSync(path.join(res.worktreePath!, "debug.log"))).toBe(false);
  });

  it("never seeds from node_modules (pruned from the project walk)", async () => {
    const repo = makeRepo();
    fs.writeFileSync(path.join(repo, ".gitignore"), "node_modules/\n*.local\n", "utf8");
    fs.mkdirSync(path.join(repo, "node_modules", "pkg"), { recursive: true });
    fs.writeFileSync(path.join(repo, "node_modules", "pkg", "cfg.local"), "dep\n", "utf8");
    fs.writeFileSync(path.join(repo, "app.local"), "app\n", "utf8");
    fs.writeFileSync(path.join(repo, ".worktreeinclude"), "*.local\n", "utf8");

    const mgr = makeManager(repo);
    const res = await mgr.enter({ name: "nm" });
    expect(res.ok).toBe(true);
    expect(res.seededFiles).toEqual(["app.local"]);
    expect(fs.existsSync(path.join(res.worktreePath!, "node_modules"))).toBe(false);
  });
});

describe("WorktreeManager.exit", () => {
  it("keep unlocks but leaves directory and branch in place", async () => {
    const repo = makeRepo();
    const mgr = makeManager(repo);
    const res = await mgr.enter({ name: "kept" });
    expect((await mgr.list()).find((e) => e.branch === "worktree-kept")?.locked).toBe(true);

    const exit = await mgr.exit({ worktreePath: res.worktreePath!, action: "keep" });
    expect(exit).toMatchObject({ ok: true, removed: false, orphaned: false });
    expect(fs.existsSync(res.worktreePath!)).toBe(true);
    const entry = (await mgr.list()).find((e) => e.branch === "worktree-kept");
    expect(entry).toBeDefined();
    expect(entry!.locked).toBe(false);
  });

  it("remove deletes the worktree, prunes it from the list, and deletes the merged branch", async () => {
    const repo = makeRepo();
    const mgr = makeManager(repo);
    const res = await mgr.enter({ name: "gone" });
    expect(res.ok).toBe(true);

    const exit = await mgr.exit({ worktreePath: res.worktreePath!, action: "remove" });
    expect(exit.ok).toBe(true);
    expect(exit.removed).toBe(true);
    expect(exit.orphaned).toBe(false);
    expect(fs.existsSync(res.worktreePath!)).toBe(false);
    expect((await mgr.list()).map((e) => path.resolve(e.path))).toEqual([repo]);
    expect(git(repo, "branch", "--list", "worktree-gone")).toBe("");
  });

  it("tolerates a held worktree (orphaned: true, ok: true) and reapOrphans cleans it later", async () => {
    const repo = makeRepo();
    const mgr = makeManager(repo);
    const res = await mgr.enter({ name: "busy" });
    expect(res.ok).toBe(true);

    // Hold a handle: a live process whose cwd is inside the worktree blocks
    // directory removal on Windows.
    const holdDir = path.join(res.worktreePath!, "hold");
    fs.mkdirSync(holdDir);
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      cwd: holdDir,
      stdio: "ignore",
    });
    children.push(child);
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });

    const exit = await mgr.exit({ worktreePath: res.worktreePath!, action: "remove" });
    expect(exit.ok).toBe(true); // NEVER hard-fails
    if (process.platform === "win32") {
      expect(exit.removed || exit.orphaned).toBe(true);
    }

    await stopChild(child);

    if (fs.existsSync(res.worktreePath!)) {
      expect(exit.orphaned).toBe(true);
      const stale = new Date(Date.now() - 1_000);
      fs.utimesSync(res.worktreePath!, stale, stale);
      const reap = await mgr.reapOrphans({ maxAgeDays: 0 });
      expect(reap.reaped.map((p) => path.resolve(p))).toContain(path.resolve(res.worktreePath!));
    }
    expect(fs.existsSync(res.worktreePath!)).toBe(false);
  });

  it("refuses to remove the main working tree (containment) and deletes nothing", async () => {
    const repo = makeRepo();
    const mgr = makeManager(repo);

    // Old code: `git worktree remove <root>` fails, and the unguarded rmSync
    // fallback deleted the ENTIRE project including .git.
    const exit = await mgr.exit({ worktreePath: repo, action: "remove" });
    expect(exit.ok).toBe(false);
    expect(exit.removed).toBe(false);
    expect(exit.orphaned).toBe(false);
    expect(exit.error).toMatch(/refusing to remove/);
    expect(fs.existsSync(path.join(repo, "README.md"))).toBe(true);
    expect(fs.existsSync(path.join(repo, ".git"))).toBe(true);
    expect(git(repo, "rev-parse", "HEAD")).toBeTruthy();
  });

  it("refuses to remove paths outside .claude/worktrees (nested repo, plain dir, worktrees root)", async () => {
    const repo = makeRepo();
    const mgr = makeManager(repo);

    // Unrelated nested repo — has a .git of its own; old code deleted it wholesale.
    const nested = path.join(repo, "vendor", "other");
    fs.mkdirSync(nested, { recursive: true });
    git(nested, "init");
    fs.writeFileSync(path.join(nested, "keep.txt"), "keep\n", "utf8");
    const exitNested = await mgr.exit({ worktreePath: nested, action: "remove" });
    expect(exitNested.ok).toBe(false);
    expect(fs.existsSync(path.join(nested, "keep.txt"))).toBe(true);

    // Plain directory.
    const plain = path.join(repo, "plain");
    fs.mkdirSync(plain);
    const exitPlain = await mgr.exit({ worktreePath: plain, action: "remove" });
    expect(exitPlain.ok).toBe(false);
    expect(fs.existsSync(plain)).toBe(true);

    // The worktrees root itself is not a worktree either.
    const root = path.join(repo, ".claude", "worktrees");
    fs.mkdirSync(root, { recursive: true });
    const exitRoot = await mgr.exit({ worktreePath: root, action: "remove" });
    expect(exitRoot.ok).toBe(false);
    expect(fs.existsSync(root)).toBe(true);
  });
});

describe("WorktreeManager.reapOrphans", () => {
  it("treats an absent worktrees root as a healthy empty scan", async () => {
    const repo = makeRepo();
    const worktreesRoot = path.join(repo, ".claude", "worktrees");
    expect(fs.existsSync(worktreesRoot)).toBe(false);
    const mgr = new WorktreeManager({
      projectRoot: repo,
      settings: { baseRef: "head" },
      reapIo: {
        readDirectories: (root) => {
          expect(path.resolve(root)).toBe(path.resolve(worktreesRoot));
          throw Object.assign(new Error("worktrees root absent"), { code: "ENOENT" });
        },
      },
    });

    const reap = await mgr.reapOrphans();
    expect(reap).toEqual({
      reaped: [],
      retainedWorktrees: 0,
      failureCounts: failureCounts(),
      diagnostics: [],
    });
  });

  it("retains classification for genuine worktrees root scan failures", async () => {
    const repo = makeRepo();
    const mgr = new WorktreeManager({
      projectRoot: repo,
      settings: { baseRef: "head" },
      reapIo: {
        readDirectories: () => {
          throw Object.assign(new Error("scan failed"), { code: "EIO" });
        },
      },
    });

    const reap = await mgr.reapOrphans();
    expect(reap.reaped).toEqual([]);
    expect(reap.retainedWorktrees).toBe(0);
    expect(reap.failureCounts).toEqual(failureCounts({ "other-io": 1 }));
    expect(reap.diagnostics).toContainEqual(
      expect.objectContaining({ message: expect.stringContaining("directory scan failed") }),
    );
  });

  it("removes manually-orphaned dirs under .claude/worktrees but leaves live worktrees alone", async () => {
    const repo = makeRepo();
    const mgr = makeManager(repo);
    const alive = await mgr.enter({ name: "alive" });
    expect(alive.ok).toBe(true);

    const zombie = path.join(repo, ".claude", "worktrees", "zombie");
    fs.mkdirSync(path.join(zombie, "sub"), { recursive: true });
    fs.writeFileSync(path.join(zombie, "sub", "junk.txt"), "x\n", "utf8");
    const staleTime = new Date(Date.now() - 1_000);
    fs.utimesSync(zombie, staleTime, staleTime);

    const reap = await mgr.reapOrphans({ maxAgeDays: 0 });
    expect(reap.reaped.map((p) => path.resolve(p))).toEqual([path.resolve(zombie)]);
    expect(reap.retainedWorktrees).toBe(0);
    expect(reap.failureCounts).toEqual(failureCounts());
    expect(fs.existsSync(zombie)).toBe(false);
    expect(fs.existsSync(alive.worktreePath!)).toBe(true);
    expect((await mgr.list()).some((e) => path.resolve(e.path) === path.resolve(alive.worktreePath!))).toBe(true);
  });

  it("defaults to 30 days and retains exact-cutoff equality", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2035-06-01T12:00:00.000Z"));
    const repo = makeRepo();
    const mgr = makeManager(repo);
    const dayMs = 24 * 60 * 60 * 1000;

    const fresh = path.join(repo, ".claude", "worktrees", "fresh-orphan");
    const equal = path.join(repo, ".claude", "worktrees", "equal-orphan");
    const stale = path.join(repo, ".claude", "worktrees", "stale-orphan");
    for (const dir of [fresh, equal, stale]) fs.mkdirSync(dir, { recursive: true });
    fs.utimesSync(fresh, new Date(Date.now() - dayMs), new Date(Date.now() - dayMs));
    fs.utimesSync(equal, new Date(Date.now() - 30 * dayMs), new Date(Date.now() - 30 * dayMs));
    fs.utimesSync(stale, new Date(Date.now() - 30 * dayMs - 1_000), new Date(Date.now() - 30 * dayMs - 1_000));

    const reap = await mgr.reapOrphans();
    expect(reap.reaped.map((p) => path.resolve(p))).toEqual([path.resolve(stale)]);
    expect(reap.retainedWorktrees).toBe(0);
    expect(reap.failureCounts).toEqual(failureCounts());
    expect(fs.existsSync(fresh)).toBe(true);
    expect(fs.existsSync(equal)).toBe(true);

    const reapNow = await mgr.reapOrphans({ maxAgeDays: 0 });
    expect(reapNow.reaped.map((p) => path.resolve(p)).sort()).toEqual(
      [path.resolve(equal), path.resolve(fresh)].sort(),
    );
  });

  it("skips deletion when retention cleanup admission is blocked", async () => {
    const repo = makeRepo();
    const mgr = makeManager(repo, { baseRef: "head" }, { retentionCleanupAllowed: false });
    const orphan = path.join(repo, ".claude", "worktrees", "blocked-orphan");
    fs.mkdirSync(orphan, { recursive: true });

    const reap = await mgr.reapOrphans({ maxAgeDays: 0 });
    expect(reap.reaped).toEqual([]);
    expect(reap.retainedWorktrees).toBe(0);
    expect(reap.failureCounts).toEqual(failureCounts({ "settings-blocked": 1 }));
    expect(fs.existsSync(orphan)).toBe(true);
    expect(reap.diagnostics).toContainEqual(
      expect.objectContaining({ message: expect.stringContaining("deletion skipped") }),
    );
  });

  it.each([
    ["EACCES", "permission"],
    ["EBUSY", "busy"],
    ["EIO", "other-io"],
  ] as const)("classifies %s removal failures as %s and counts the retained orphan", async (code, category) => {
    const repo = makeRepo();
    const orphan = path.join(repo, ".claude", "worktrees", `${category}-orphan`);
    fs.mkdirSync(orphan, { recursive: true });
    const stale = new Date(Date.now() - 1_000);
    fs.utimesSync(orphan, stale, stale);
    const mgr = new WorktreeManager({
      projectRoot: repo,
      settings: { baseRef: "head" },
      reapIo: {
        remove: () => { throw Object.assign(new Error(code), { code }); },
      },
    });

    const reap = await mgr.reapOrphans({ maxAgeDays: 0 });
    expect(reap.reaped).toEqual([]);
    expect(reap.retainedWorktrees).toBe(1);
    expect(reap.failureCounts).toEqual(failureCounts({ [category]: 1 }));
    expect(fs.existsSync(orphan)).toBe(true);
  });
});

describe("gitignore handling", () => {
  it("appends .claude/worktrees/ to .git/info/exclude when not ignored, exactly once", async () => {
    const repo = makeRepo();
    const mgr = makeManager(repo);
    const first = await mgr.enter({ name: "ig-a" });
    expect(first.ok).toBe(true);
    expect(first.diagnostics.some((d) => /info[\\/]exclude/.test(d.message))).toBe(true);

    const excludePath = path.join(repo, ".git", "info", "exclude");
    const countLine = (): number =>
      fs
        .readFileSync(excludePath, "utf8")
        .split(/\r?\n/)
        .filter((l) => l.trim() === ".claude/worktrees/").length;
    expect(countLine()).toBe(1);
    expect(git(repo, "check-ignore", "--", ".claude/worktrees/probe")).toBe(".claude/worktrees/probe");

    const second = await mgr.enter({ name: "ig-b" });
    expect(second.ok).toBe(true);
    expect(countLine()).toBe(1); // idempotent
  });

  it("does not touch info/exclude when .gitignore already covers .claude/worktrees/", async () => {
    const repo = makeRepo();
    fs.writeFileSync(path.join(repo, ".gitignore"), ".claude/worktrees/\n", "utf8");
    const mgr = makeManager(repo);
    const res = await mgr.enter({ name: "ig-c" });
    expect(res.ok).toBe(true);

    const excludePath = path.join(repo, ".git", "info", "exclude");
    const excludeText = fs.existsSync(excludePath) ? fs.readFileSync(excludePath, "utf8") : "";
    expect(excludeText.split(/\r?\n/).some((l) => l.trim() === ".claude/worktrees/")).toBe(false);
  });
});

describe("parallel worktrees", () => {
  it("supports two concurrent worktrees with independent exits", async () => {
    const repo = makeRepo();
    const mgr = makeManager(repo);
    const a = await mgr.enter({ name: "wt-a" });
    const b = await mgr.enter({ name: "wt-b" });
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    expect(a.branch).toBe("worktree-wt-a");
    expect(b.branch).toBe("worktree-wt-b");

    const listed = (await mgr.list()).map((e) => path.resolve(e.path));
    expect(listed).toContain(path.resolve(a.worktreePath!));
    expect(listed).toContain(path.resolve(b.worktreePath!));
    expect(listed).toContain(repo);

    // Work in both independently.
    fs.writeFileSync(path.join(a.worktreePath!, "a.txt"), "a\n", "utf8");
    fs.writeFileSync(path.join(b.worktreePath!, "b.txt"), "b\n", "utf8");

    const exitA = await mgr.exit({ worktreePath: a.worktreePath!, action: "remove" });
    expect(exitA.ok).toBe(true);
    expect(fs.existsSync(a.worktreePath!)).toBe(false);
    // b untouched by a's exit.
    expect(fs.existsSync(path.join(b.worktreePath!, "b.txt"))).toBe(true);
    expect((await mgr.list()).map((e) => path.resolve(e.path))).toContain(path.resolve(b.worktreePath!));

    const exitB = await mgr.exit({ worktreePath: b.worktreePath!, action: "remove" });
    expect(exitB.ok).toBe(true);
    expect(fs.existsSync(b.worktreePath!)).toBe(false);
    expect((await mgr.list()).map((e) => path.resolve(e.path))).toEqual([repo]);
  });
});

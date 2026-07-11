import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WorktreeManager, flattenWorktreeName } from "../src/runtime/worktrees.js";
import type { WorktreeSettings } from "../src/types.js";

const tempDirs: string[] = [];
const children: ChildProcess[] = [];

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true }).trim();
}

function makeRepo(): string {
  let dir = fs.mkdtempSync(path.join(os.tmpdir(), "pcd-wt-"));
  dir = fs.realpathSync.native(dir);
  tempDirs.push(dir);
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

function makeManager(projectRoot: string, settings: WorktreeSettings = { baseRef: "head" }): WorktreeManager {
  return new WorktreeManager({ projectRoot, settings });
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

    const plainDir = path.join(repo, "plain");
    fs.mkdirSync(plainDir);
    const notWorktree = await mgr.enter({ path: plainDir });
    expect(notWorktree.ok).toBe(false);
    expect(notWorktree.error).toMatch(/not a registered git worktree/);
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
      const reap = await mgr.reapOrphans();
      expect(reap.reaped.map((p) => path.resolve(p))).toContain(path.resolve(res.worktreePath!));
    }
    expect(fs.existsSync(res.worktreePath!)).toBe(false);
  });
});

describe("WorktreeManager.reapOrphans", () => {
  it("removes manually-orphaned dirs under .claude/worktrees but leaves live worktrees alone", async () => {
    const repo = makeRepo();
    const mgr = makeManager(repo);
    const alive = await mgr.enter({ name: "alive" });
    expect(alive.ok).toBe(true);

    const zombie = path.join(repo, ".claude", "worktrees", "zombie");
    fs.mkdirSync(path.join(zombie, "sub"), { recursive: true });
    fs.writeFileSync(path.join(zombie, "sub", "junk.txt"), "x\n", "utf8");

    const reap = await mgr.reapOrphans();
    expect(reap.reaped.map((p) => path.resolve(p))).toEqual([path.resolve(zombie)]);
    expect(fs.existsSync(zombie)).toBe(false);
    expect(fs.existsSync(alive.worktreePath!)).toBe(true);
    expect((await mgr.list()).some((e) => path.resolve(e.path) === path.resolve(alive.worktreePath!))).toBe(true);
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

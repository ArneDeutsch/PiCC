import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import picomatch from "picomatch";
import type { Diagnostic, WorktreeSettings } from "../types.js";
import { isDirectory, readTextSafe } from "../util/fs.js";

/**
 * Git worktree mechanics for EnterWorktree / ExitWorktree.
 *
 * Layout & grammar (Claude Code compatible):
 * - Worktree dir:   <projectRoot>/.claude/worktrees/<flat-name>/
 * - Branch:         worktree-<flat-name> (the "leftover base branch")
 * - Base commit:    resolved to a concrete SHA BEFORE `git worktree add`, and
 *                   recorded in <dir>/.claude/.picc/base-commit
 *
 * Windows posture: best-effort removal (strip reparse points, tolerate stuck
 * `worktree remove`, reap orphans later), core.longpaths, never hard-fail.
 * Public methods never throw — they return error results / diagnostics.
 */

export type ExecFn = (
  cmd: string,
  args: string[],
  opts: { cwd: string; timeoutMs?: number },
) => Promise<{ stdout: string; stderr: string; code: number }>;

export interface WorktreeEnterResult {
  ok: boolean;
  worktreePath?: string;
  branch?: string;
  baseCommit?: string;
  created: boolean;
  seededFiles: string[];
  diagnostics: Diagnostic[];
  error?: string;
}

export interface WorktreeExitResult {
  ok: boolean;
  removed: boolean;
  orphaned: boolean;
  diagnostics: Diagnostic[];
  error?: string;
}

export interface WorktreeListEntry {
  path: string;
  branch?: string;
  locked: boolean;
}

type VerifiedWorktreeList =
  | { ok: true; entries: WorktreeListEntry[] }
  | { ok: false; error: string };

export interface WorktreeReapResult {
  reaped: string[];
  diagnostics: Diagnostic[];
}

const SOURCE = "worktrees";
const LOCK_REASON = "picc-active";
const IGNORE_LINE = ".claude/worktrees/";
const BASE_COMMIT_REL = path.join(".claude", ".picc", "base-commit");

function diag(severity: Diagnostic["severity"], message: string): Diagnostic {
  return { severity, message, source: SOURCE };
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Default ExecFn: node:child_process.execFile — arguments are never shell-interpolated. */
const defaultExec: ExecFn = (cmd, args, opts) =>
  new Promise((resolve) => {
    execFile(
      cmd,
      args,
      {
        cwd: opts.cwd,
        timeout: opts.timeoutMs ?? 60_000,
        windowsHide: true,
        maxBuffer: 16 * 1024 * 1024,
        encoding: "utf8",
      },
      (err, stdout, stderr) => {
        let code = 0;
        if (err) {
          const raw = (err as NodeJS.ErrnoException & { code?: unknown }).code;
          code = typeof raw === "number" ? raw : 1;
        }
        resolve({ stdout: stdout ?? "", stderr: stderr ?? "", code });
      },
    );
  });

/** Canonicalize a path for comparisons across git (forward-slash) and Windows forms. */
function canonical(p: string): string {
  let out = path.resolve(p).replace(/\\/g, "/").replace(/\/+$/, "");
  if (process.platform === "win32") out = out.toLowerCase();
  return out;
}

/** `feature/x` -> `feature-x`; lowercase; only [a-z0-9-_] survive, runs of others -> `-`. */
export function flattenWorktreeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
}

function readBaseCommitFile(worktreeDir: string): string | undefined {
  const text = readTextSafe(path.join(worktreeDir, BASE_COMMIT_REL));
  const sha = text?.trim();
  return sha ? sha : undefined;
}

/** One compiled `.worktreeinclude` line: gitignore semantics, `!` un-matches earlier matches. */
interface IncludeRule {
  negated: boolean;
  match: (rel: string) => boolean;
}

/** Compile one `.worktreeinclude` line (gitignore-flavoured) against project-relative paths. */
function compileIncludeLine(raw: string): IncludeRule {
  let pattern = raw;
  const negated = pattern.startsWith("!");
  if (negated) pattern = pattern.slice(1);
  pattern = pattern.replace(/\\/g, "/");
  if (pattern.startsWith("/")) pattern = pattern.slice(1);
  if (pattern.endsWith("/")) pattern += "**";
  // nonegate: picomatch must never invert a stray `!` into a match-everything pattern.
  const opts = { dot: true, nocase: process.platform === "win32", windows: false, nonegate: true };
  const direct = picomatch(pattern, opts);
  if (pattern.includes("/")) return { negated, match: (rel) => direct(rel) };
  const deep = picomatch(`**/${pattern}`, opts);
  return { negated, match: (rel) => direct(rel) || deep(rel) };
}

function parsePorcelain(stdout: string): WorktreeListEntry[] {
  const out: WorktreeListEntry[] = [];
  let cur: WorktreeListEntry | undefined;
  for (const line of stdout.split(/\r?\n/)) {
    if (line.trim() === "") {
      if (cur) out.push(cur);
      cur = undefined;
      continue;
    }
    if (line.startsWith("worktree ")) {
      if (cur) out.push(cur);
      cur = { path: line.slice("worktree ".length), locked: false };
    } else if (!cur) {
      continue;
    } else if (line.startsWith("branch ")) {
      cur.branch = line.slice("branch ".length).replace(/^refs\/heads\//, "");
    } else if (line === "locked" || line.startsWith("locked ")) {
      cur.locked = true;
    }
  }
  if (cur) out.push(cur);
  return out;
}

export class WorktreeManager {
  private readonly projectRoot: string;
  private readonly settings: WorktreeSettings;
  /** Claude settings `cleanupPeriodDays` — default max-age for orphan reaping. */
  private readonly cleanupPeriodDays: number | undefined;
  private readonly exec: ExecFn;
  /** Construction-time setup (core.longpaths on win32); never rejects. */
  private readonly ready: Promise<void>;

  constructor(opts: {
    projectRoot: string;
    settings: WorktreeSettings;
    cleanupPeriodDays?: number;
    exec?: ExecFn;
  }) {
    this.projectRoot = path.resolve(opts.projectRoot);
    this.settings = opts.settings;
    this.cleanupPeriodDays = opts.cleanupPeriodDays;
    this.exec = opts.exec ?? defaultExec;
    this.ready =
      process.platform === "win32"
        ? this.git(["config", "core.longpaths", "true"]).then(
            () => undefined,
            () => undefined,
          )
        : Promise.resolve();
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  async enter(opts: { name?: string; path?: string }): Promise<WorktreeEnterResult> {
    const diagnostics: Diagnostic[] = [];
    try {
      await this.ready;
      const hasName = typeof opts.name === "string";
      const hasPath = typeof opts.path === "string";
      if (hasName === hasPath) {
        const error =
          "EnterWorktree: exactly one of `name` or `path` must be provided (they are mutually exclusive)";
        return { ok: false, created: false, seededFiles: [], diagnostics: [diag("error", error)], error };
      }
      if (hasPath) return await this.enterByPath(opts.path!, diagnostics);
      return await this.enterByName(opts.name!, diagnostics);
    } catch (e) {
      const error = `EnterWorktree failed: ${errorMessage(e)}`;
      diagnostics.push(diag("error", error));
      return { ok: false, created: false, seededFiles: [], diagnostics, error };
    }
  }

  async exit(opts: { worktreePath: string; action: "keep" | "remove" }): Promise<WorktreeExitResult> {
    const diagnostics: Diagnostic[] = [];
    try {
      await this.ready;
      const dir = path.resolve(opts.worktreePath);

      // HARD CONTAINMENT: destructive removal only ever runs on dirs strictly
      // inside <root>/.claude/worktrees/ — never the main working tree, never
      // an arbitrary/nested-repo path. Refuse before any mutation (no unlock,
      // no reparse-point stripping, no rmSync).
      if (opts.action === "remove" && !this.isManagedWorktreePath(dir)) {
        const error = `ExitWorktree: refusing to remove ${dir} — it is not inside ${this.worktreesRoot()}`;
        diagnostics.push(diag("error", error));
        return { ok: false, removed: false, orphaned: false, diagnostics, error };
      }

      let branch: string | undefined;
      if (opts.action === "remove") {
        const listed = await this.listVerified();
        if (!listed.ok) {
          const error = `ExitWorktree: refusing to remove ${dir} because git worktree state is unavailable (${listed.error})`;
          diagnostics.push(diag("error", error));
          return { ok: false, removed: false, orphaned: false, diagnostics, error };
        }
        branch = listed.entries.find((e) => canonical(e.path) === canonical(dir))?.branch;
        if (branch === undefined) branch = `worktree-${path.basename(dir)}`;
      }

      // Unlock in both modes (ignore failures — may not be locked).
      await this.git(["worktree", "unlock", dir]);

      if (opts.action === "keep") {
        return { ok: true, removed: false, orphaned: false, diagnostics };
      }

      // --- remove: Windows-tolerant best-effort sequence ---
      if (process.platform === "win32") this.stripReparsePoints(dir, diagnostics);

      const removeRes = await this.git(["worktree", "remove", dir, "--force"]);
      if (removeRes.code !== 0) {
        diagnostics.push(
          diag(
            "info",
            `git worktree remove failed (${removeRes.stderr.trim() || `exit ${removeRes.code}`}); falling back to direct removal`,
          ),
        );
        try {
          fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
        } catch (e) {
          diagnostics.push(diag("warning", `direct removal of ${dir} failed: ${errorMessage(e)}`));
        }
        if (fs.existsSync(dir)) {
          // Sever the gitdir pointer so `worktree prune` can drop the admin
          // entry and the leftover dir becomes a plain orphan for the reaper.
          try {
            fs.rmSync(path.join(dir, ".git"), { force: true });
          } catch {
            /* best-effort */
          }
        }
        await this.git(["worktree", "prune"]);
      }

      const stillPresent = fs.existsSync(dir);

      // Delete the leftover base branch if fully merged (ignore failure).
      if (branch?.startsWith("worktree-")) {
        await this.git(["branch", "-d", branch]);
      }

      if (stillPresent) {
        diagnostics.push(
          diag("warning", `worktree ${dir} could not be fully removed; orphan left for the reaper`),
        );
        return { ok: true, removed: false, orphaned: true, diagnostics };
      }
      return { ok: true, removed: true, orphaned: false, diagnostics };
    } catch (e) {
      diagnostics.push(diag("error", `ExitWorktree failed: ${errorMessage(e)}`));
      return { ok: false, removed: false, orphaned: false, diagnostics };
    }
  }

  /**
   * Remove orphaned dirs under .claude/worktrees (leftovers of blocked
   * removals). Active/locked worktrees are registered with git and never
   * touched; everything reaped passes the same containment gate as exit().
   * `maxAgeDays` (default: the settings `cleanupPeriodDays`, else 0 = reap
   * immediately) grants younger orphans a grace period, keyed off dir mtime.
   */
  async reapOrphans(options?: { maxAgeDays?: number }): Promise<WorktreeReapResult> {
    const diagnostics: Diagnostic[] = [];
    const reaped: string[] = [];
    try {
      await this.ready;
      const maxAgeDays = options?.maxAgeDays ?? this.cleanupPeriodDays ?? 0;
      const cutoffMs = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
      const beforePrune = await this.listVerified();
      if (!beforePrune.ok) {
        diagnostics.push(diag("warning", `orphan reaping skipped: ${beforePrune.error}`));
        return { reaped, diagnostics };
      }
      const prune = await this.git(["worktree", "prune"]);
      if (prune.code !== 0) {
        diagnostics.push(diag("warning", `orphan reaping skipped: git worktree prune failed (${prune.stderr.trim() || `exit ${prune.code}`})`));
        return { reaped, diagnostics };
      }
      const listed = await this.listVerified();
      if (!listed.ok) {
        diagnostics.push(diag("warning", `orphan reaping skipped: ${listed.error}`));
        return { reaped, diagnostics };
      }
      const registered = new Set(listed.entries.map((e) => canonical(e.path)));
      const worktreesRoot = this.worktreesRoot();
      let entries: fs.Dirent[] = [];
      try {
        entries = fs.readdirSync(worktreesRoot, { withFileTypes: true });
      } catch {
        return { reaped, diagnostics };
      }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const dir = path.join(worktreesRoot, entry.name);
        if (registered.has(canonical(dir))) continue; // active/locked worktrees stay
        if (!this.isManagedWorktreePath(dir)) continue; // containment (defense in depth)
        if (maxAgeDays > 0) {
          try {
            if (fs.statSync(dir).mtimeMs > cutoffMs) continue; // within grace period
          } catch {
            continue; // cannot stat — leave it for a later pass
          }
        }
        if (process.platform === "win32") this.stripReparsePoints(dir, diagnostics);
        try {
          fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
        } catch (e) {
          diagnostics.push(diag("warning", `reap of ${dir} failed: ${errorMessage(e)}`));
        }
        await this.git(["worktree", "prune"]);
        if (!fs.existsSync(dir)) {
          reaped.push(dir);
        } else {
          diagnostics.push(diag("warning", `orphaned worktree dir ${dir} still present after reap attempt`));
        }
      }
      return { reaped, diagnostics };
    } catch (e) {
      diagnostics.push(diag("error", `reapOrphans failed: ${errorMessage(e)}`));
      return { reaped, diagnostics };
    }
  }

  async list(): Promise<WorktreeListEntry[]> {
    const result = await this.listVerified();
    return result.ok ? result.entries : [];
  }

  // -------------------------------------------------------------------------
  // enter: name mode (create or reuse)
  // -------------------------------------------------------------------------

  private async enterByName(name: string, diagnostics: Diagnostic[]): Promise<WorktreeEnterResult> {
    const flat = flattenWorktreeName(name);
    if (flat === "") {
      const error = `EnterWorktree: name ${JSON.stringify(name)} flattens to an empty string`;
      diagnostics.push(diag("error", error));
      return { ok: false, created: false, seededFiles: [], diagnostics, error };
    }
    const dir = path.join(this.projectRoot, ".claude", "worktrees", flat);

    if (isDirectory(dir)) {
      const listed = await this.listVerified();
      if (!listed.ok) {
        const error = `EnterWorktree: cannot verify existing worktree ${dir} (${listed.error})`;
        diagnostics.push(diag("error", error));
        return { ok: false, created: false, seededFiles: [], diagnostics, error };
      }
      const entry = listed.entries.find((e) => canonical(e.path) === canonical(dir));
      if (entry) {
        // Reuse the existing REGISTERED worktree — create nothing, seed nothing.
        await this.ensureWorktreesIgnored(diagnostics);
        await this.git(["worktree", "lock", "--reason", LOCK_REASON, dir]); // ignore failure
        return {
          ok: true,
          worktreePath: dir,
          branch: entry.branch,
          baseCommit: readBaseCommitFile(dir),
          created: false,
          seededFiles: [],
          diagnostics,
        };
      }
      // Unregistered leftover (e.g. a partially removed worktree with its .git
      // pointer severed): adopting it would run the session against the MAIN
      // repo's git context. Reap it and fall through to fresh creation.
      diagnostics.push(
        diag("info", `${dir} exists but is not a registered worktree; reaping the orphan and recreating`),
      );
      if (process.platform === "win32") this.stripReparsePoints(dir, diagnostics);
      try {
        fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      } catch (e) {
        diagnostics.push(diag("warning", `orphan removal of ${dir} failed: ${errorMessage(e)}`));
      }
      await this.git(["worktree", "prune"]);
      if (fs.existsSync(dir)) {
        const error = `EnterWorktree: ${dir} is an orphaned non-worktree directory that could not be removed`;
        diagnostics.push(diag("error", error));
        return { ok: false, created: false, seededFiles: [], diagnostics, error };
      }
    }

    // Resolve the base commit to a concrete SHA BEFORE `git worktree add` —
    // worktree base-commit resolution, claude-code issue #60588.
    const baseCommit = await this.resolveBaseCommit(diagnostics);
    if (baseCommit === undefined) {
      const error = "EnterWorktree: could not resolve a base commit (repo has no commits?)";
      diagnostics.push(diag("error", error));
      return { ok: false, created: false, seededFiles: [], diagnostics, error };
    }

    const branchChoice = await this.pickBranch(flat);
    if (branchChoice === undefined) {
      const error = "EnterWorktree: could not verify worktree state before selecting a branch";
      diagnostics.push(diag("error", error));
      return { ok: false, created: false, seededFiles: [], diagnostics, error };
    }
    const { branch, reuseBranch } = branchChoice;
    if (reuseBranch) {
      diagnostics.push(diag("info", `reusing existing branch ${branch} (its worktree dir is gone)`));
      await this.git(["worktree", "prune"]); // clear any stale admin entry holding the branch
    }

    const addArgs = reuseBranch
      ? ["worktree", "add", dir, branch]
      : ["worktree", "add", "-b", branch, dir, baseCommit];
    const addRes = await this.git(addArgs);
    if (addRes.code !== 0) {
      const error = `git worktree add failed: ${addRes.stderr.trim() || `exit ${addRes.code}`}`;
      diagnostics.push(diag("error", error));
      return { ok: false, created: false, seededFiles: [], diagnostics, error };
    }

    // A reused branch is checked out at its OLD tip (never reset — it may
    // carry unmerged work that a reset would destroy), so the resolved base is
    // NOT what this worktree sits on. Record where the branch diverged from
    // the resolved base (merge-base; fallback: the branch tip) so that
    // `base..HEAD` stays a sane unit-of-work delta.
    let recordedBase = baseCommit;
    if (reuseBranch) {
      const mb = await this.git(["merge-base", branch, baseCommit]);
      if (mb.code === 0 && mb.stdout.trim() !== "") {
        recordedBase = mb.stdout.trim();
      } else {
        const tip = await this.git(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);
        if (tip.code === 0 && tip.stdout.trim() !== "") recordedBase = tip.stdout.trim();
      }
    }

    // Record the base commit inside the worktree.
    try {
      const baseFile = path.join(dir, BASE_COMMIT_REL);
      fs.mkdirSync(path.dirname(baseFile), { recursive: true });
      fs.writeFileSync(baseFile, `${recordedBase}\n`, "utf8");
    } catch (e) {
      diagnostics.push(diag("warning", `could not record base commit: ${errorMessage(e)}`));
    }

    await this.ensureWorktreesIgnored(diagnostics);
    const seededFiles = await this.seedWorktree(dir, diagnostics);
    await this.git(["worktree", "lock", "--reason", LOCK_REASON, dir]); // ignore failure

    return { ok: true, worktreePath: dir, branch, baseCommit: recordedBase, created: true, seededFiles, diagnostics };
  }

  // -------------------------------------------------------------------------
  // enter: path mode (re-entry, creates nothing)
  // -------------------------------------------------------------------------

  private async enterByPath(rawPath: string, diagnostics: Diagnostic[]): Promise<WorktreeEnterResult> {
    const dir = path.resolve(rawPath);
    if (!isDirectory(dir)) {
      const error = `EnterWorktree: path ${dir} is not an existing directory`;
      diagnostics.push(diag("error", error));
      return { ok: false, created: false, seededFiles: [], diagnostics, error };
    }
    // The main working tree IS listed by `git worktree list` — never accept it
    // (an ExitWorktree(remove) on it would be catastrophic), and never accept
    // anything outside the managed .claude/worktrees/ root.
    if (canonical(dir) === canonical(this.projectRoot)) {
      const error = `EnterWorktree: path ${dir} is the main working tree, not a worktree`;
      diagnostics.push(diag("error", error));
      return { ok: false, created: false, seededFiles: [], diagnostics, error };
    }
    if (!this.isManagedWorktreePath(dir)) {
      const error = `EnterWorktree: path ${dir} is outside ${this.worktreesRoot()}; only managed worktrees can be re-entered`;
      diagnostics.push(diag("error", error));
      return { ok: false, created: false, seededFiles: [], diagnostics, error };
    }
    const listed = await this.listVerified();
    if (!listed.ok) {
      const error = `EnterWorktree: cannot verify path ${dir} as a registered git worktree (${listed.error})`;
      diagnostics.push(diag("error", error));
      return { ok: false, created: false, seededFiles: [], diagnostics, error };
    }
    const entry = listed.entries.find((e) => canonical(e.path) === canonical(dir));
    if (!entry) {
      const error = `EnterWorktree: path ${dir} is not a registered git worktree`;
      diagnostics.push(diag("error", error));
      return { ok: false, created: false, seededFiles: [], diagnostics, error };
    }
    await this.git(["worktree", "lock", "--reason", LOCK_REASON, dir]); // ignore failure
    return {
      ok: true,
      worktreePath: dir,
      branch: entry.branch,
      baseCommit: readBaseCommitFile(dir),
      created: false,
      seededFiles: [],
      diagnostics,
    };
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /** Root that owns every managed worktree: `<projectRoot>/.claude/worktrees`. */
  private worktreesRoot(): string {
    return path.join(this.projectRoot, ".claude", "worktrees");
  }

  /**
   * True only for paths STRICTLY inside .claude/worktrees/ — the containment
   * gate every destructive operation (and path re-entry) must pass. The main
   * working tree, nested repos, and the worktrees root itself all fail it.
   */
  private isManagedWorktreePath(p: string): boolean {
    const root = canonical(this.worktreesRoot());
    const c = canonical(p);
    return c !== root && c.startsWith(`${root}/`);
  }

  private async git(args: string[], cwd = this.projectRoot): Promise<{ stdout: string; stderr: string; code: number }> {
    try {
      return await this.exec("git", args, { cwd });
    } catch (e) {
      return { stdout: "", stderr: errorMessage(e), code: 1 };
    }
  }

  private async listVerified(): Promise<VerifiedWorktreeList> {
    await this.ready;
    const res = await this.git(["worktree", "list", "--porcelain"]);
    if (res.code !== 0) {
      return {
        ok: false,
        error: `git worktree list failed (${res.stderr.trim() || `exit ${res.code}`})`,
      };
    }
    return { ok: true, entries: parsePorcelain(res.stdout) };
  }

  /**
   * Resolve worktree.baseRef to a concrete SHA before creating anything.
   * "head" -> HEAD; "fresh" -> origin/HEAD, then origin/main, origin/master, then HEAD.
   */
  private async resolveBaseCommit(diagnostics: Diagnostic[]): Promise<string | undefined> {
    if (this.settings.baseRef === "fresh") {
      for (const ref of ["origin/HEAD", "origin/main", "origin/master"]) {
        const res = await this.git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
        if (res.code === 0 && res.stdout.trim() !== "") return res.stdout.trim();
      }
      diagnostics.push(diag("info", 'baseRef "fresh": no usable origin ref; falling back to HEAD'));
    }
    const res = await this.git(["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);
    if (res.code === 0 && res.stdout.trim() !== "") return res.stdout.trim();
    return undefined;
  }

  /**
   * Pick the branch for a new worktree: `worktree-<flat>`. If that branch
   * already exists, reuse it when its worktree dir is gone (not checked out in
   * any still-existing worktree); otherwise suffix -2, -3, ...
   */
  private async pickBranch(flat: string): Promise<{ branch: string; reuseBranch: boolean } | undefined> {
    const listed = await this.listVerified();
    if (!listed.ok) return undefined;
    const inUse = new Set<string>();
    for (const entry of listed.entries) {
      if (entry.branch !== undefined && isDirectory(entry.path)) inUse.add(entry.branch);
    }
    let candidate = `worktree-${flat}`;
    for (let i = 2; i < 1000; i++) {
      const exists =
        (await this.git(["rev-parse", "--verify", "--quiet", `refs/heads/${candidate}`])).code === 0;
      if (!exists) return { branch: candidate, reuseBranch: false };
      if (!inUse.has(candidate)) return { branch: candidate, reuseBranch: true };
      candidate = `worktree-${flat}-${i}`;
    }
    return { branch: `worktree-${flat}-${Date.now()}`, reuseBranch: false };
  }

  /**
   * Ensure `.claude/worktrees/` is gitignored. If not (per `git check-ignore`,
   * which sees .gitignore and info/exclude), append to `.git/info/exclude` —
   * harness-owned, never touches tracked files.
   */
  private async ensureWorktreesIgnored(diagnostics: Diagnostic[]): Promise<void> {
    const probe = ".claude/worktrees/__picc_probe__";
    const check = await this.git(["check-ignore", "-q", "--", probe]);
    if (check.code === 0) return; // already ignored (via .gitignore or info/exclude)

    let gitDir = path.join(this.projectRoot, ".git");
    const res = await this.git(["rev-parse", "--path-format=absolute", "--git-common-dir"]);
    if (res.code === 0 && res.stdout.trim() !== "") gitDir = res.stdout.trim();

    const excludePath = path.join(gitDir, "info", "exclude");
    try {
      const existing = readTextSafe(excludePath) ?? "";
      const alreadyThere = existing.split(/\r?\n/).some((l) => l.trim() === IGNORE_LINE);
      if (alreadyThere) return;
      fs.mkdirSync(path.dirname(excludePath), { recursive: true });
      const prefix = existing === "" || existing.endsWith("\n") ? "" : "\n";
      fs.appendFileSync(excludePath, `${prefix}${IGNORE_LINE}\n`, "utf8");
      diagnostics.push(
        diag("info", `.claude/worktrees/ was not gitignored; appended it to ${excludePath}`),
      );
    } catch (e) {
      diagnostics.push(diag("warning", `could not update ${excludePath}: ${errorMessage(e)}`));
    }
  }

  /**
   * `.worktreeinclude` seeding: copy matching gitignored files from projectRoot
   * into a NEWLY created worktree at the same relative path.
   */
  private async seedWorktree(worktreeDir: string, diagnostics: Diagnostic[]): Promise<string[]> {
    const includeText = readTextSafe(path.join(this.projectRoot, ".worktreeinclude"));
    if (includeText === undefined) return [];
    const patterns = includeText
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l !== "" && l !== "!" && !l.startsWith("#"));
    if (patterns.length === 0) return [];

    const rules = patterns.map(compileIncludeLine);
    // Only negations -> nothing can ever be included; skip the project walk.
    if (!rules.some((r) => !r.negated)) return [];
    // gitignore semantics: the LAST matching line decides (a `!` line un-matches).
    const included = (rel: string): boolean => {
      let inc = false;
      for (const rule of rules) if (rule.match(rel)) inc = !rule.negated;
      return inc;
    };
    const candidates = this.walkProjectFiles().filter(included);
    if (candidates.length === 0) return [];

    const ignored = await this.filterGitIgnored(candidates, diagnostics);
    const seeded: string[] = [];
    for (const rel of [...ignored].sort()) {
      try {
        const src = path.join(this.projectRoot, ...rel.split("/"));
        const dst = path.join(worktreeDir, ...rel.split("/"));
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        fs.copyFileSync(src, dst);
        seeded.push(rel);
      } catch (e) {
        diagnostics.push(diag("warning", `could not seed ${rel}: ${errorMessage(e)}`));
      }
    }
    return seeded;
  }

  /** Recursive walk of projectRoot -> relative forward-slash file paths (skips .git, node_modules, worktrees, links). */
  private walkProjectFiles(): string[] {
    const out: string[] = [];
    const walk = (abs: string, rel: string, depth: number): void => {
      if (depth > 32) return;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(abs, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        // node_modules is never a seeding source; walking it costs O(10^5) fs
        // entries per worktree creation, and creation latency must stay bounded.
        if (entry.name === ".git" || entry.name === "node_modules") continue;
        const childRel = rel === "" ? entry.name : `${rel}/${entry.name}`;
        if (childRel === ".claude/worktrees") continue;
        if (entry.isSymbolicLink()) continue; // never follow links while seeding
        const childAbs = path.join(abs, entry.name);
        if (entry.isDirectory()) walk(childAbs, childRel, depth + 1);
        else if (entry.isFile()) out.push(childRel);
      }
    };
    walk(this.projectRoot, "", 0);
    return out;
  }

  /** Keep only paths git considers ignored (seeding must never clobber tracked files). */
  private async filterGitIgnored(relPaths: string[], diagnostics: Diagnostic[]): Promise<string[]> {
    const out: string[] = [];
    const chunkSize = 50;
    for (let i = 0; i < relPaths.length; i += chunkSize) {
      const chunk = relPaths.slice(i, i + chunkSize);
      // Note: `-z` requires `--stdin` (git 2.48); plain newline output + quotePath=false instead.
      const res = await this.git(["-c", "core.quotePath=false", "check-ignore", "--", ...chunk]);
      if (res.code === 0) {
        out.push(
          ...res.stdout
            .split(/\r?\n/)
            .map((s) => s.replace(/\\/g, "/").trim())
            .filter((s) => s !== ""),
        );
      } else if (res.code === 1) {
        // none of this chunk is ignored — copy nothing from it
      } else {
        diagnostics.push(
          diag("warning", `git check-ignore failed (exit ${res.code}); seeding all matched files of this chunk`),
        );
        out.push(...chunk);
      }
    }
    return out;
  }

  /**
   * Windows: unlink any junction/symlink directory entry at any depth inside
   * the tree (as a LINK, never following it), so recursive removal cannot
   * escape into the link target.
   */
  private stripReparsePoints(root: string, diagnostics: Diagnostic[]): void {
    const stack: string[] = [root];
    while (stack.length > 0) {
      const dir = stack.pop()!;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        let st: fs.Stats;
        try {
          st = fs.lstatSync(full);
        } catch {
          continue;
        }
        if (st.isSymbolicLink()) {
          // Junctions and dir symlinks report as symbolic links via lstat.
          try {
            fs.unlinkSync(full);
          } catch {
            try {
              fs.rmdirSync(full); // removes the junction entry without following
            } catch (e) {
              diagnostics.push(diag("warning", `could not remove link ${full}: ${errorMessage(e)}`));
            }
          }
        } else if (st.isDirectory()) {
          stack.push(full);
        }
      }
    }
  }
}

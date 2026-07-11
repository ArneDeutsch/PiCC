# 03 — Worktrees and Git Integration

Research for replicating Claude Code's git-worktree workspace isolation
("EnterWorkspace / LeaveWorkspace") in a new GPT/Codex harness, so it can
drive the DemonMatrix skill corpus unchanged.

Reference project: `F:/Arne/Projekte/DemonMatrix` (a Rust game project already
run through a Codex harness via `codex.ps1`).
Target project: `F:/Arne/Projekte/PiClauDex` (the new harness).

The tools are named **`EnterWorktree`** and **`ExitWorktree`** (not
Enter/LeaveWorkspace — that is the user's informal name). This doc uses the
real tool names.

---

## (a) The DemonMatrix worktree contract (from local evidence)

### a.1 What the harness must expose

The DemonMatrix skills call exactly two main-session orchestrator tools plus a
set of `git` and `tools/dm-*.sh` shell calls. The contract the skills assume:

| Tool | Argument forms | Behavior the skills rely on |
|------|----------------|-----------------------------|
| `EnterWorktree(name: "<flat>")` | `name:` = flat worktree dir name `m<NN>-<f\|c><NN>` | Creates a **new** worktree under `.claude/worktrees/<name>/` on a **new branch** based off the resolved base ref; **changes the session cwd** into it. |
| `EnterWorktree(path: "<abs>")` | `path:` = absolute path to an existing worktree | Enters/re-enters an **existing** worktree (resume); changes cwd; creates nothing. |
| `ExitWorktree(action: keep\|remove)` | — | Present in the harness but the DemonMatrix `/merge` skill does **not** use it — it exits manually via raw git (see a.6). The new harness must still provide it for interactive `--worktree` sessions. |

`name:` and `path:` are **mutually exclusive**. The skills never pass both.

### a.2 Live evidence — worktree layout

`git -C F:/Arne/Projekte/DemonMatrix worktree list --porcelain` returned:

```
worktree F:/Arne/Projekte/DemonMatrix
HEAD 352337642d3d19e3c4ee353993cc393ab291739c
branch refs/heads/main

worktree F:/Arne/Projekte/DemonMatrix/.claude/worktrees/m09-c26
HEAD a857813021cc970df356b9ad0b3ffaffef3f04b6
detached

worktree F:/Arne/Projekte/DemonMatrix/.claude/worktrees/m09-f06
HEAD 77c6f90befefe83554dc7e0662b5f86f3cfd91de
branch refs/heads/m09/f06-animation-system-and-viewer-playback
```

Observations:
- Worktrees live at `<repo>/.claude/worktrees/<flat-name>/`. Flat names:
  `m09-c26`, `m09-f06`. Directory name is **dash-joined**, never `m09/f06`
  (a `/` would nest a directory).
- `m09-f06` is an **active** worktree: checked out on its container branch
  `m09/f06-animation-system-and-viewer-playback` (branch name uses a `/`).
- `m09-c26` is a **detached** worktree with no branch — a **post-merge orphan**
  (see a.6): after `/merge` it was detached and its branch deleted, but the
  directory could not be removed (Windows), awaiting auto-reap.

### a.3 Git plumbing layout (what the harness creates)

The worktree is a standard linked git worktree, **plus one harness-specific
file**:

`<repo>/.claude/worktrees/m09-f06/.git` is a **file** (not a dir) containing:
```
gitdir: F:/Arne/Projekte/DemonMatrix/.git/worktrees/m09-f06
```

`<repo>/.git/worktrees/m09-f06/` (the per-worktree admin dir) contains:
```
HEAD          -> ref: refs/heads/m09/f06-animation-system-and-viewer-playback
index         (per-worktree index, ~468 KB)
commondir     -> "../.."         (points back to shared <repo>/.git)
gitdir        -> "F:/Arne/Projekte/DemonMatrix/.claude/worktrees/m09-f06/.git"
ORIG_HEAD
COMMIT_EDITMSG
logs/         (per-worktree reflog)
refs/
CLAUDE_BASE   -> "bf1cca64db3a01793b8460151c01be2cf58df8dc"   <-- harness file
```

**`CLAUDE_BASE` is the harness's own record of the base commit** the worktree
was created from (40-hex SHA). This is how `worktree.baseRef` is persisted per
worktree. The new harness must write an equivalent file (name can differ, but
DemonMatrix's git plumbing does not depend on the name — only the harness reads
it). For `m09-f06`: `CLAUDE_BASE=bf1cca64…` while `HEAD` points at the container
branch tip `77c6f90b…` → the worktree was created detached at the base commit,
then the container branch was created on top and checked out.

### a.4 The `worktree-<name>` leftover base branch

`dispatch-floor/SKILL.md` §1.3 states verbatim:

> `EnterWorktree(name:)` creates a leftover base branch `worktree-<name>`; the
> git-setup's "create off `main`" then checks out the container branch,
> superseding it. `/merge` reaps the leftover; do not delete or avoid it here.

So the **fresh-create path** does two things the skills depend on:
1. `git worktree add -b worktree-<name> <path> <baseRef>` — creates the
   worktree on a **new branch literally named `worktree-<name>`**.
2. The skill then immediately `git checkout -b m<NN>/<f|c><NN>-<slug>` (off
   `main`) inside the worktree, **superseding** that base branch. The
   `worktree-<name>` branch is now unreferenced but still exists as a ref.

`/merge` Step 2 auto-reaps these leftovers (see a.6). At the moment of capture
no `worktree-*` branches existed (`git branch --list "worktree-*"` empty) — they
had already been reaped, confirming the reap path runs.

> Note: the current PiClauDex `EnterWorktree` (see section (e)) names the branch
> `worktree-<name>` — matching this exactly. The DemonMatrix contract is already
> satisfied by that naming.

### a.5 Enter/resume detection — the exact algorithm

From `dispatch-floor/SKILL.md` §1 "Worktree-entry sub-step" and
`/implement` Step 2 and `/collaborate` Step 2.4:

1. Run `tools/dm-preflight.sh`, read its `mode=` line.
   - **`mode=worktree`** → already inside a worktree (same-session resume). Do
     nothing; fall through to git-setup.
   - **`mode=main`** → launched on `main`; must isolate.
2. On `mode=main`, probe `git worktree list --porcelain` for an existing
   worktree whose **path basename == flat name** `m<NN>-<f|c><NN>` **OR** whose
   **checked-out branch matches the container-branch glob** `m<NN>/<f|c><NN>*`.
   - **Found (resume)** → `EnterWorktree(path: <absolute worktree path>)`.
   - **Not found (fresh)** → `EnterWorktree(name: "m<NN>-<f|c><NN>")`.
3. After entry the cwd is inside the worktree; every later git step runs there.

`dm-preflight.sh` implements `mode` detection **without** command substitution
(the Codex harness cannot statically analyze `$(...)` for allowlisting):

```sh
common_dir=$(git rev-parse --path-format=absolute --git-common-dir)   # <repo>/.git
git_dir=$(git rev-parse --path-format=absolute --git-dir)             # <repo>/.git/worktrees/<name> in a linked WT
if [ "$common_dir" != "$git_dir" ]; then
    mode="worktree"; main_path=$(dirname "$common_dir")   # parent of <repo>/.git == the main tree
else
    mode="main";     main_path=$(pwd)
fi
branch=$(git rev-parse --abbrev-ref HEAD)
# emits: mode=… / main_path=… / branch=…
```

The harness's cwd change is the **only** thing that makes this work: the skill
runs `dm-preflight.sh` in the session cwd, so after `EnterWorktree` the same
script now reports `mode=worktree`. **The new harness MUST change the process/
session cwd on Enter and restore it on Exit.**

### a.6 The merge + reap lifecycle

`/merge` (`merge/SKILL.md`) is the container-grain close. Its worktree handling:

**Step 2 — detect + auto-reap (runs from any session):**
- `dm-preflight.sh` gives `mode`, `main_path`, `branch`.
- **Reap orphaned worktrees:** for each worktree ≠ `main_path` that is
  `detached`, if `git -C <wt> merge-base --is-ancestor HEAD main` → the worktree
  holds no unique work → `git -C "$MAIN_PATH" worktree remove --force <wt>`.
  Failures silent (retried next `/merge`).
- **Reap orphaned `worktree-*` base branches:** candidates from
  `git branch --list "worktree-*"` minus the in-use set (parsed from
  `worktree list --porcelain` `branch refs/heads/<name>` lines); for each not
  in-use, if `merge-base --is-ancestor <branch> main` → `git branch -d <branch>`
  (`-d` not `-D`, refuses unmerged as a second guard). Silent failures.

**Step 4 — merge (worktree mode):**
```
git -C "$MAIN_PATH" merge --no-ff <container-branch>   # merge into main, without moving this WT's HEAD
git checkout --detach                                   # release the branch so it can be deleted
git -C "$MAIN_PATH" branch -d <container-branch>
git -C "$MAIN_PATH" worktree remove --force "$PWD"      # on Windows this TYPICALLY FAILS — captured quietly
```
The `git checkout --detach` is exactly what produced the `m09-c26` detached
orphan observed in a.2. The Windows `worktree remove` failure is expected; the
directory is reaped by Step 2 on a later `/merge` from another session.

**Merge (main-session mode)** is simpler: `git merge --no-ff <branch>` then
`git branch -d <branch>` in the single checkout.

### a.7 The write-guard (out-of-worktree edit warning)

`settings.json` wires a `PreToolUse` hook on `Edit|MultiEdit|Write` →
`bash tools/dm-worktree-guard.sh`. It is **warn-only, never blocks**:

1. Read the `PreToolUse` JSON payload on stdin; parse `tool_input.file_path`
   with grep/sed (no `jq` on this machine). Windows paths arrive JSON-escaped
   with **doubled backslashes** (`C:\\Users\\…`) → un-double before use.
2. **Mode gate:** call `dm-preflight.sh`; if `mode != worktree` → silent exit 0
   (no guard in a main session).
3. **Root:** `git rev-parse --show-toplevel` from the hook cwd (= worktree root).
   Fallback: walk `file_path` to the nearest enclosing
   `.claude/worktrees/<name>` segment.
4. **Canonicalize** both `file_path` and root to one namespace (`cygpath -m`
   mixed-drive form on Git-for-Windows, else `realpath -m`) and prefix-compare
   with a trailing-slash guard against sibling false-matches.
   - Inside root → silent allow.
   - Outside root → **warn** (write still proceeds) via stdout JSON:
     `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow","additionalContext":"<text>"}}`.
5. Any internal error degrades to **silent allow + stderr breadcrumb** — a
   broken guard never wedges the session. Always exit 0.

The warning explicitly excuses the one legitimate cross-tree write: `/merge`'s
`$MAIN_PATH` status rollup.

### a.8 The hooksPath-restore hook (git config shared across worktrees)

`settings.json` also has a `PostToolUse` hook on `Bash` gated `if: Bash(git *)`:
```
[ "$(git config core.hooksPath 2>/dev/null)" = ".githooks" ] || git config core.hooksPath .githooks
```
`core.hooksPath` is **shared repo config** (see section (c)); the repo pins it
to `.githooks` (a `pre-commit` hook lives there). This hook re-asserts it after
any git command, so a stray reset never disables the pre-commit gate — and it
works from any worktree because `.githooks` is a repo-relative path present in
every worktree checkout. The new harness must honor `PostToolUse` hooks with the
`if:` conditional matcher.

### a.9 Naming grammar (single-homed in `state-model` §Branch & worktree name grammar)

- **Container branch:** `m<NN>/f<NN>-<slug>` (feature) or `m<NN>/c<NN>-<slug>`
  (chore). Contains a `/`.
- **Container-branch glob** (resolve/probe): `m<NN>/<f|c><NN>*`.
- **Flat worktree directory name:** `m<NN>-<f|c><NN>` (e.g. `m09-c04`) — the
  `EnterWorktree(name:)` argument. **Never** `m<NN>/…` (would nest the dir).
- **Leftover base branch:** `worktree-<flat-name>` (e.g. `worktree-m09-c26`).

The harness's `name:` validator must accept `/`-free names of letters, digits,
dots, underscores, dashes; DemonMatrix only ever passes flat dashed names.

### a.10 The Codex harness bridge (already in the reference project)

`codex.ps1` at the DemonMatrix root shows how the project is already run under a
GPT/Codex harness — directly relevant to PiClauDex:
- Sets `$env:CODEX_HOME = <repo>/.codex-home`.
- Creates `<repo>/.codex-home/skills/` and **junctions** each
  `.claude/skills/<dir>` into it (`New-Item -ItemType Junction`), plus junctions
  the system skills. This mounts the Claude-style skill corpus into Codex's
  skill discovery path without copying.
- Invokes `codex -C $repoRoot @CodexArgs`.

Implication: PiClauDex can present `.claude/skills` to a GPT model via junctions,
and must add native `EnterWorktree`/`ExitWorktree` tools + the `worktree.baseRef`
setting + the two hooks, since Codex itself does not provide worktree isolation.

---

## (b) git worktree mechanics reference (enough to re-implement)

### b.1 Model
A **linked worktree** is a second working directory attached to one repository.
All worktrees **share** the object database and most refs via the common
`.git` dir; each has its **own** `HEAD`, index, and per-worktree reflog.

- Main worktree: `.git` is a **directory**.
- Linked worktree: `.git` is a **file** — `gitdir: <path to admin dir>`.
- Admin dir: `<repo>/.git/worktrees/<id>/` with `HEAD`, `index`, `commondir`
  (relative path back to shared `.git`), `gitdir` (absolute path to the linked
  worktree's `.git` file), `ORIG_HEAD`, `logs/`, `refs/bisect`, etc.
- Inside a linked worktree: `$GIT_DIR` = the admin dir,
  `$GIT_COMMON_DIR` = the shared `.git`. Detect a worktree by comparing
  `git rev-parse --git-dir` vs `--git-common-dir` (they differ ⇔ linked).

### b.2 Core commands

| Command | Notes |
|---------|-------|
| `git worktree add <path> [<commit-ish>]` | Creates a worktree. With no branch arg and `add <path> <branch>`, checks out that branch. |
| `git worktree add -b <new-branch> <path> [<base>]` | Creates `<new-branch>` off `<base>` (default `HEAD`) and checks it out in the new worktree. **This is the fresh-create form.** |
| `git worktree add --detach <path> [<commit>]` | Detached HEAD at `<commit>` — no branch consumed. |
| `git worktree add --lock <path>` | Create already-locked (blocks prune/auto-remove). |
| `git worktree list [--porcelain]` | Porcelain emits `worktree <path>` / `HEAD <sha>` / `branch <ref>` or `detached`, blank-line-separated. Parse this, not the human form. |
| `git worktree remove [--force] <path>` | Refuses if the worktree is dirty (untracked/modified) or locked; `--force` overrides dirty (twice for locked). Removes the dir + admin metadata. |
| `git worktree move <src> <dst>` | Relocate. |
| `git worktree lock/unlock <path> [--reason]` | Lock prevents prune/removal (e.g. removable media, or an agent actively working). |
| `git worktree prune [--expire <time>]` | Deletes admin entries for worktrees whose directories are gone. Does **not** touch on-disk dirs. |

### b.3 Rules that constrain the design
- **One branch, one worktree.** `git worktree add` refuses a branch already
  checked out in another worktree ("already checked out at …"). Same for
  `git checkout <branch>` / `git switch`. → A worktree that wants to *hand its
  branch back* must first `git checkout --detach` (exactly what `/merge` does).
- A branch checked out in a worktree **cannot be deleted** (`branch -d/-D`
  refuse "used by worktree"). Detach first, then delete.
- **Detached base:** creating at a raw commit consumes no branch — useful for a
  "base commit" worktree onto which a named branch is later layered (the
  DemonMatrix pattern: base at `CLAUDE_BASE`, then container branch on top).
- Deleting a worktree directory with `rm -rf` instead of `git worktree remove`
  leaves a **stale admin entry**; `git worktree prune` cleans it. Removing while
  a process holds it (Windows lock) is the common failure → reap later.
- Worktrees do **not** copy untracked/gitignored files (`.env`, `target/`,
  `node_modules/`) — each is a fresh checkout. Claude Code solves this with a
  `.worktreeinclude` file (gitignore syntax; copies matched *gitignored* files
  into each new worktree).

### b.4 baseRef resolution (Claude Code semantics to replicate)

`worktree.baseRef` accepts only two literals (not arbitrary refs):

- **`fresh`** (default): branch from the repo's **default branch**
  `origin/HEAD` (clean tree matching the remote). If no remote or the fetch
  fails, **fall back to local `HEAD`**. Correct command:
  `git worktree add -b <branch> <path> origin/<default-branch>`.
- **`head`**: branch from the current local **`HEAD`** — carries unpushed
  commits and feature-branch state. Command:
  `git worktree add -b <branch> <path>` (base defaults to HEAD).

**DemonMatrix uses `"head"`** (`settings.json`). That is what makes the
"launch on `main`, base the worktree off `main`'s current commit" flow work when
`main` is the checked-out branch. (A known Claude Code bug, issue #60588 v2.1.144,
was that `EnterWorktree` ignored `fresh` and always used HEAD — a caution for
the re-implementation: resolve base **before** `git worktree add` and pass it
explicitly.)

PR base form (optional to replicate): `#<num>` fetches `pull/<num>/head` from
origin and creates `.claude/worktrees/pr-<num>`.

### b.5 Cleanup semantics (Claude Code)
- On session exit **with no changes** (no uncommitted, no untracked, no new
  commits): worktree + branch removed automatically (named sessions prompt).
- **With changes:** prompt keep/remove; remove discards everything.
- `-p` non-interactive `--worktree`: never auto-cleaned (no exit prompt).
- Subagent/background worktrees are swept when older than `cleanupPeriodDays`
  **only if** clean; `--worktree` ones are never swept.
- While an agent runs, Claude `git worktree lock`s its worktree so concurrent
  cleanup cannot remove it; unlock on finish.

---

## (c) git hooks across worktrees

- **`.git/hooks/` is shared** across all worktrees via `$GIT_COMMON_DIR`. A
  hook that assumes the main worktree's path misbehaves when fired from a linked
  worktree. Write hooks to use `git rev-parse --show-toplevel` (the *current*
  worktree root), never a hardcoded path.
- **`core.hooksPath` is shared repo config.** Setting it (e.g. `.githooks`)
  applies to every worktree. Because it is a **repo-relative** path, and every
  worktree checks out `.githooks/`, one setting Just Works across worktrees —
  which is why DemonMatrix pins `core.hooksPath=.githooks` and re-asserts it
  after every git command (a.8).
- **Per-worktree config** requires opting in:
  `git config extensions.worktreeConfig true`. Then per-worktree values live in
  `$(git rev-parse --git-path config.worktree)` and are written with
  `git config --worktree <k> <v>`. Without it, **all** worktrees share
  `core.*`, `user.email`, etc. DemonMatrix does **not** enable it (no
  `config.worktree` present) — it wants one shared hook path.
- Caveat for a harness that would set per-worktree hooks: enabling
  `extensions.worktreeConfig` promotes some keys (notably `core.bare`,
  `core.worktree`) to the per-worktree file — handle migration carefully. For
  DemonMatrix's needs, **leave it off** and rely on the shared `.githooks` +
  the restore hook.
- Pre-commit hooks that install their own environment per checkout (e.g.
  `prek`/`pre-commit`) can race in a fresh worktree that hasn't bootstrapped —
  bootstrap the dev env per worktree before the first commit.

---

## (d) Windows specifics (win32, the user's environment)

The user runs Windows 11 with PowerShell **and** Git Bash; the harness must
straddle both.

- **`worktree remove` frequently fails on Windows** while any process holds a
  handle inside the worktree (an editor, a running `cargo`/build, antivirus,
  even the harness's own cwd). DemonMatrix's `/merge` treats this as expected:
  detach + delete branch succeed, `worktree remove --force` is attempted and its
  failure captured quietly; the orphaned dir is auto-reaped on a later `/merge`.
  **Replicate this "best-effort remove, reap-later" pattern** — do not hard-fail
  a merge on a stuck `worktree remove`.
- **Junctions / symlinks:** the Codex bridge (`codex.ps1`) mounts skills via
  **NTFS junctions** (`New-Item -ItemType Junction`). Claude Code, before
  removing a worktree on Windows, removes any NTFS junction or directory symlink
  at **any depth** inside it *as a link entry*, so removal doesn't recurse
  through the link and delete the link **target's** files outside the worktree.
  The new harness must do the same: enumerate reparse points inside the worktree
  and unlink them (not recursively delete) before `worktree remove`. `git config
  core.symlinks=false` is set in this repo (Windows default) — symlinks are
  checked out as plain files.
- **Path length:** worktrees nest under `.claude/worktrees/<name>/…` which adds
  depth; combined with deep source trees this can exceed the legacy 260-char
  `MAX_PATH`. Enable `git config core.longpaths true` and/or the Windows
  long-path policy. Keep flat worktree names short (DemonMatrix's `m09-c26` is 7
  chars — good).
- **Line endings:** repo sets `core.autocrlf=false` and ships `.gitattributes`
  in each worktree — worktrees inherit `.gitattributes` (tracked) so EOL
  normalization is consistent across them. Do **not** flip `autocrlf` per
  worktree.
- **Path namespaces:** the write-guard canonicalizes with `cygpath -m` (mixed
  `F:/…` drive form) to reconcile Git-Bash `/f/…`, Windows `F:\…`, and the
  JSON-doubled-backslash payloads. Any path comparison the harness does on
  Windows must canonicalize to one namespace first.
- **`case-insensitive, filemode=false`:** `core.ignorecase=true`,
  `core.filemode=false` in this repo — do not rely on case or exec-bit
  distinctions in worktree paths.
- **No command substitution in allowlisted commands:** the Codex harness
  allowlists literal command prefixes and cannot analyze `$(...)`. That is why
  DemonMatrix wraps `git rev-parse …` detection inside `tools/dm-preflight.sh`
  (one allowlisted `bash tools/dm-*.sh` prefix). The new harness's permission
  model should allow `Bash(tools/dm-*.sh:*)` and `Bash(git:*)` so the skills run
  unprompted.

---

## (e) Spec for the new harness's EnterWorktree / ExitWorktree + git setup

This is the concrete contract PiClauDex must implement to run the DemonMatrix
corpus unchanged. (The Claude Code tool schemas already match; this restates
them as an implementation target.)

### e.1 Settings

Read `worktree.baseRef` from `settings.json`, value `"fresh"` | `"head"`
(default `"fresh"`). DemonMatrix ships `"head"`. Also honor `PreToolUse` and
`PostToolUse` hooks (with the `if:` conditional matcher used by the hooksPath
restore hook) and the permission `allow` list.

### e.2 `EnterWorktree`

Parameters (mutually exclusive): `name?: string`, `path?: string`. If neither,
generate a random name.

**Create path — `name:` given (or generated):**
1. Refuse if the session is already inside a worktree (switching via `path` is
   allowed, creating is not).
2. Validate `name`: each `/`-separated segment only `[A-Za-z0-9._-]`, ≤64 chars.
   (DemonMatrix passes flat `m<NN>-<f|c><NN>`.)
3. Resolve base ref:
   - `head` → `HEAD` (its resolved SHA).
   - `fresh` → `origin/<default-branch>` (from `origin/HEAD`); if no remote or
     fetch fails → fall back to `HEAD`.
   - Resolve to a concrete SHA **before** adding, and persist it to a
     `CLAUDE_BASE` file in the worktree admin dir
     (`<repo>/.git/worktrees/<name>/CLAUDE_BASE`).
4. `git worktree add -b worktree-<name> <repo>/.claude/worktrees/<name> <baseSHA>`
   — new branch literally `worktree-<name>` (the DemonMatrix "leftover base
   branch" the merge reaps).
5. Copy `.worktreeinclude`-matched gitignored files into the new worktree (opt).
6. **Change the session cwd** to the new worktree; relocate CWD-dependent state
   (system-prompt sections, memory/CLAUDE.md resolution, plans dir, transcript
   storage). Register the worktree for exit-time cleanup.
7. `git worktree lock` it while the agent is active (release on finish) so a
   concurrent sweep can't remove it.

**Enter/resume path — `path:` given:**
1. Require `path` to appear in `git worktree list` for the current repo (or a
   nested repo, first entry only). Reject otherwise.
2. Change the session cwd to it; relocate CWD-dependent state. **Create
   nothing.** Mark it as *entered-by-path* so `ExitWorktree` will **not** remove
   it (only `keep` returns to the original dir).

Both paths leave every subsequent `git`/`tools/dm-*.sh` call running inside the
worktree — the invariant the skills depend on (a.5).

### e.3 `ExitWorktree`

Parameter: `action: "keep" | "remove"`, `discard_changes?: boolean` (default
false). Scope: **only** worktrees created by `EnterWorktree` in *this* session;
otherwise no-op.

- Restore the session cwd to the pre-Enter directory; clear CWD-dependent
  caches; relocate transcript back.
- `keep`: leave directory + branch on disk.
- `remove`: `git worktree remove` (best-effort `--force` on Windows). **Refuse**
  if the worktree has uncommitted files or commits not on the original branch
  unless `discard_changes: true`; on refusal, list the changes.
- On a `path`-entered worktree, `remove` is disallowed — only `keep`.
- Windows: strip reparse points (junctions/symlinks) at any depth first (d).

> DemonMatrix's `/merge` does **not** call `ExitWorktree` — it exits by raw git
> (`git checkout --detach`, `branch -d`, `worktree remove --force`, reap-later).
> The harness must not interfere with that manual path; `ExitWorktree` is for
> interactive/`--worktree` sessions and non-skill flows.

### e.4 Session-exit cleanup (interactive)
Mirror Claude Code: clean session with no changes → auto-remove worktree+branch
(prompt if the session is named); with changes → prompt keep/remove; `-p`
non-interactive → never auto-remove. Swept only if clean and older than
`cleanupPeriodDays`; `--worktree`/named ones never swept.

### e.5 Git setup the harness must guarantee
- `core.hooksPath` honored (repo pins `.githooks`); support the `PostToolUse`
  restore hook.
- Do **not** enable `extensions.worktreeConfig` (DemonMatrix wants shared
  config).
- Allowlist `Bash(git:*)` and `Bash(tools/dm-*.sh:*)` so preflight/guard/commit
  scripts run unprompted.
- Provide a `PreToolUse` hook seam on `Edit|MultiEdit|Write` (the write-guard),
  passing `tool_input.file_path` in the JSON payload (Windows: doubled
  backslashes) and honoring `hookSpecificOutput.permissionDecision:"allow"` +
  `additionalContext` for warn-only feedback.
- Set/keep on Windows: `core.longpaths true`, `core.autocrlf false`,
  `core.symlinks false` (repo defaults).

### e.6 Contract checklist (must all hold)
- [ ] `EnterWorktree(name:)` creates `.claude/worktrees/<name>/` on branch
      `worktree-<name>`, based off resolved `baseRef`, records base SHA, changes
      cwd.
- [ ] `EnterWorktree(path:)` re-enters existing worktree, changes cwd, creates
      nothing.
- [ ] After entry, `git rev-parse --git-dir` ≠ `--git-common-dir` (so
      `dm-preflight.sh` reports `mode=worktree`).
- [ ] Session cwd is the worktree for all later tool calls; restored on exit.
- [ ] `worktree.baseRef: "head"` bases off local HEAD.
- [ ] Container branch created *by the skill* (`git checkout -b m<NN>/…`)
      supersedes `worktree-<name>`; harness does not fight it.
- [ ] `worktree remove` failures on Windows are non-fatal (reap-later).
- [ ] `PreToolUse`/`PostToolUse` hooks with `matcher` and `if:` supported.
- [ ] `.claude/worktrees/` is gitignored so worktree contents don't show as
      untracked in the main checkout.

---

## (f) Sources

Local evidence (DemonMatrix, read-only):
- `git -C F:/Arne/Projekte/DemonMatrix worktree list --porcelain`
- `F:/Arne/Projekte/DemonMatrix/.claude/settings.json`
- `.git/worktrees/m09-f06/` and `…/m09-c26/` admin dirs (HEAD, commondir,
  gitdir, index, CLAUDE_BASE)
- `.claude/worktrees/m09-f06/.git` (gitdir pointer file)
- `.git/config` (core.hooksPath=.githooks, autocrlf=false, symlinks=false,
  ignorecase=true, filemode=false)
- `.claude/skills/dispatch-floor/SKILL.md` (§1 worktree-entry, leftover base
  branch, dep-graph)
- `.claude/skills/merge/SKILL.md` (Steps 2/4 reap + detach + remove lifecycle)
- `.claude/skills/implement/SKILL.md` (Step 2 worktree-probe/resume)
- `.claude/skills/collaborate/SKILL.md` (Step 2.4 re-enter-only)
- `.claude/skills/state-model/SKILL.md` (§Branch & worktree name grammar)
- `tools/dm-preflight.sh`, `tools/dm-worktree-guard.sh`
- `codex.ps1` (Codex harness bridge via junctions)

Web:
- Run parallel sessions with worktrees — Claude Code Docs:
  https://code.claude.com/docs/en/worktrees.md
- EnterWorktree tool description (leaked system prompt), Piebald-AI:
  https://github.com/Piebald-AI/claude-code-system-prompts/blob/main/system-prompts/tool-description-enterworktree.md
- claude-code issue #60588 (baseRef fresh vs head resolution + git commands):
  https://github.com/anthropics/claude-code/issues/60588
- git-worktree(1) official docs: https://git-scm.com/docs/git-worktree
- githooks(5) official docs: https://git-scm.com/docs/githooks
- Git hooks / core.hooksPath / extensions.worktreeConfig across worktrees:
  https://hidekazu-konishi.com/entry/git_advanced_techniques_rebase_worktree_hooks.html
- Git worktrees for parallel AI agent execution — Augment Code:
  https://www.augmentcode.com/guides/git-worktrees-parallel-ai-agent-execution
- Claude Squad (parallel agents in isolated worktrees):
  https://github.com/smtg-ai/claude-squad
- Uzi (parallel AI coders via worktrees + tmux):
  https://www.vibesparking.com/en/blog/ai/claude-code/uzi/2025-08-23-uzi-parallel-ai-coders-git-worktrees-tmux/
- LLM Codegen go Brrr — worktrees + tmux parallelization:
  https://www.skeptrune.com/posts/git-worktrees-agents-and-tmux/

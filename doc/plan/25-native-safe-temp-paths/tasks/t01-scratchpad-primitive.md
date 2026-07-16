# t01: Harness scratchpad primitive — pure derivation + per-session scratch dir

## Goal

The harness computes, once per session and eagerly at activation, a native-safe per-session
scratch directory, and holds its **literal resolved path** for the system-prompt injection
in t02. On Windows the path is the forward-slash drive-letter form that both the pinned Git
Bash (as a redirect target) and the native `Read`/`Grep`/`Glob` tools resolve to the same
real directory. A pure, injectable derivation function is unit tested across platforms.
There is **no environment variable** — the contract is delivered as a literal path in the
prompt (t02), mirroring Claude Code, so a skill authored against it stays portable back to
real Claude Code (which exports no such var). The system prompt itself is not changed here
(t02 consumes the held value).

## Context & seams

- **Pure derivation helper (the testable seam).** Add an exported pure function to
  `src/util/env.ts` (already the subprocess-env module; no new cross-layer edge). Signature:
  `toNativeSafeTempForm(p: string, platform?: NodeJS.Platform): string` (platform defaults
  to `process.platform`, mirroring `resolveShellBinary(shell, env?)`'s injectable seam).
  - `win32`: return `p.replace(/\\/g, "/")` — the forward-slash drive-letter form
    (`C:\Users\A\Temp` → `C:/Users/A/Temp`). This form is a valid Git Bash redirect target
    AND is resolved identically by the native Pi Read tool (coordinator-verified live; t03
    is the automated witness). `shell` is deliberately NOT a parameter: the forward-slash
    form is valid for Git Bash, PowerShell, and native Node alike, so it would be a dead
    param; the WSL namespace is excluded at the gating layer (t02's predicate), not here.
  - Any other platform: return `p` unchanged.
- **Session scratch dir — created EAGERLY in the outer scope (critical).** In
  `src/index.ts`, declare and create the dir **synchronously in the outer `activate` scope,
  BEFORE** both (a) the fire-and-forget `void (async () => {…})()` IIFE (`~934-980`) and
  (b) the `before_agent_start` registration (`~996`). Do NOT place it inside the IIFE — that
  closure is async, error-swallowing, and may not have run when the first `before_agent_start`
  fires, so a scratch dir created there would be `undefined` at the t02 injection call site
  and races the first turn. Creation sequence (order is load-bearing):
  1. Pick the root: `process.env.CLAUDE_CODE_TMPDIR` if set (Claude Code's actual scratch
     relocation knob — honoring it is real parity and lets a Claude project's tmpdir policy
     carry over), else `os.tmpdir()`.
  2. `const rawDir = fs.mkdtempSync(path.join(root, "picc-scratch-"))` — atomic, unique.
  3. `const realDir = fs.realpathSync(rawDir)` — canonicalize 8.3 short-names / symlinks
     (this canonical string is what the "both namespaces resolve the same real file"
     property and any future is-under-scratch check depend on).
  4. `const scratchDir = toNativeSafeTempForm(realDir)` — apply the slash transform LAST,
     on the realpath'd dir. (Applying the transform first then realpath'ing would return the
     backslash form and silently undo it — do realpath → transform, not the reverse.)
  Hold `scratchDir` in the outer scope so the t02 `buildSystemPromptSuffix` call site
  captures it.
- `os.tmpdir()` / `CLAUDE_CODE_TMPDIR` read the **harness** process env, which a project
  `settings.json` cannot touch — so the harness resolves the dir rather than letting the
  model compute it from `$TEMP`. No `cygpath` spawn is used anywhere in the harness path.

## Writable surface

- `src/util/env.ts` (add + export `toNativeSafeTempForm`)
- `src/index.ts` (add `import os from "node:os"` — currently only `fs`/`path` are imported;
  create `scratchDir` eagerly in the outer scope; hold it for the t02 call site)
- `test/subprocess-env.test.ts` (or a unit block in a new `test/native-temp-paths.test.ts`)
  for the pure-derivation table
- No other files. **No spawnHook / env-var changes** (the earlier `CLAUDE_SCRATCHPAD_DIR`
  export is dropped).

## Approach constraints

- The derivation function is **pure** and side-effect free; all disk/OS interaction stays in
  `index.ts`.
- Off-`win32`, `toNativeSafeTempForm` returns its input byte-for-byte; the Unix scratch dir
  is an ordinary `os.tmpdir()`/`CLAUDE_CODE_TMPDIR` path.
- Uniqueness/safety rests on `mkdtempSync` (atomic, unpredictable basename). Note honestly:
  POSIX `mkdtemp` yields mode 0700 (load-bearing under a world-writable `/tmp`); on Windows
  `mkdtempSync` ignores POSIX mode and the dir inherits the per-user `%LOCALAPPDATA%\Temp`
  ACL — the defense there is the unpredictable basename + per-user parent ACL, not a mode.
  Do not add a `chmod` or assume a 0700 guarantee on Windows.

## Left open

- Whether to include a flattened-project prefix in the mkdtemp template
  (`picc-scratch-<flattened-root>-`) for debuggability, à la Claude's scratchpad shape —
  cosmetic; implementer's call.
- Whether to clean up the session scratch dir on process exit — **out of scope** (transient,
  per-user ACL'd; retention is #41). Do not add exit handlers here.

## Testing

- **Unit (ungated, all OSes)** — table-driven `toNativeSafeTempForm`, following the
  env/platform-injection precedent at `test/skills.test.ts:755-796`:
  - `("C:\\Users\\A\\Temp", "win32")` ⇒ `"C:/Users/A/Temp"` (matches `/^[A-Za-z]:\//`,
    does NOT start with `/`).
  - `("/tmp/x", "linux")` ⇒ `"/tmp/x"` unchanged; `("/var/folders/x", "darwin")` unchanged.
  - Idempotence: applying twice on win32 == once.
  This block **locks the #48 regression**: the win32 result is never a bare `/tmp/...` and
  never leading-slash (the deterministic negative lives here, not in t03).

## Acceptance criteria
- [ ] `toNativeSafeTempForm(p, platform?)` exported from `src/util/env.ts`, pure, injectable.
- [ ] A per-session scratch dir is created **eagerly in the outer scope** via `mkdtempSync`,
      rooted at `CLAUDE_CODE_TMPDIR` or `os.tmpdir()`, canonicalized via `realpathSync`, then
      slash-transformed (order: mkdtemp → realpath → transform), and held for t02.
- [ ] Pure-derivation table tests pass on all platforms and lock the anti-`/tmp` regression.
- [ ] No env var is introduced; no spawnHook change.
- [ ] typecheck and full test suite green (no new failures vs. baseline).

## Depends on
–

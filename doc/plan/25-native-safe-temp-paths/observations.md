# Observations — 25-native-safe-temp-paths

Running record of friction, latent bugs, and follow-up candidates (raw material for
review.md). Dated bullets, one line each.

## 2026-07-16 — Phase 4/6 (investigation + plan review)

- Root cause confirmed empirically: #48 is a string-interpretation mismatch (native Read
  resolves `/tmp/x` drive-relative to `F:\tmp\x`), not a location mismatch — Git Bash `/tmp`
  even mounts to the native temp on this box yet the literal string still diverges.
- Faithful fix is Claude Code's scratchpad (literal path injected in the system prompt,
  all platforms) — NOT an env var; Claude has no `CLAUDE_SCRATCHPAD_DIR`. Initial plan
  fabricated one; corrected in Phase 6 after UX+parity review.
- Follow-up candidate (docs reviewer): the same vague "OS-temp path outside the worktree"
  phrasing this feature warns against still lives in `implement-feature/SKILL.md:71`,
  `references/ticket-creation.md:129`, `references/ticket-integration.md:46`. Those skills
  benefit from t02's injected guidance at runtime, but their *written* recipes could still
  reproduce the #48 trap on Windows. Out of scope here → file as a follow-up so the
  "nothing stale left behind" bar is met repo-wide.
- Follow-up candidate (UX reviewer): a Windows+GitBash user who hard-codes `> /tmp/foo` gets
  no proactive human-visible signal (compat-report/`/doctor` only fire on project-declared
  not-honored usage; a harness-provided scratchpad isn't project-declared). Detection
  (`shellNamespaceDiffersFromNative`) already exists — a one-line startup/`/doctor` hint when
  it fires would catch the trap up front. Deferred (scope) → follow-up candidate.
- Coverage note: the scratchpad contract reaches Bash-*tool* writes and prompt-guided model
  behavior; the `!`cmd`` shell-injection env (`shell-inject.ts:256`) is not wired (deferred
  in t01). Safe for evaluate (zero `!`cmd`` uses), but a future skill writing temp via
  `!`cmd`` on Windows would still hit `/tmp`. Registry/docs scope the contract honestly.

## 2026-07-16 — Phase 6 (design pivot: env var → literal path → approach B investigated → approach A chosen)

- UX+parity review killed the `CLAUDE_SCRATCHPAD_DIR` env var: Claude Code delivers the
  scratchpad as a **literal path in the system prompt**, not an env var; minting a
  `CLAUDE_`-namespaced var is a non-portable trap (undefined under real Claude Code).
  Switched to injecting the literal native-safe path.
- Maintainer challenged t05 (skill rewire) on portability grounds: adapting our own skill
  signals a design flaw since third-party skills won't be adapted. Verified Claude Code's
  behavior — it injects a scratchpad and steers off `/tmp`; evaluate broke under PiCC only
  because PiCC injected **no** scratchpad. So the harness scratchpad (t01+t02) makes
  evaluate work unmodified → **t05 dropped**; cleanup → harness/#41.
- Investigated "approach B" (transparent MSYS→native path translation in the file tools) as
  the maximally-portable fix. Findings that led to REJECTING it:
  - Parity: Claude Code does NOT translate model paths — that seam is a *known Claude bug*
    (#2602/#51144/#17994) it routes around via scratchpad + native PowerShell. So B is a
    divergence/extension, not parity.
  - Security: B must run before the permission check or an MSYS path form dodges native
    deny rules; and translating write paths into the pinned Git Bash install tree
    (`/usr/bin/…` → `C:\Program Files\Git\usr\bin\…`) is an **RCE primitive**. Containable
    only by translate-before-check + a narrow allow-list + refuse-UNC.
  - Coder: cleanest hook would be the guard `tool_call` handler (translate in place before
    `toClaudeCall`); mount-table built once at startup (cygdrive regex + one `mount` probe).
    Feasible but adds real surface to the permission-critical path.
- **Decision (maintainer): approach A — scratchpad injection only (pure parity).** Faithful,
  zero new permission-engine surface, fixes the observed dogfood failure. Does not help
  skills that hardcode `/tmp` (already broken on Claude Code too — outside the parity goal).
  The approach-B investigation notes are preserved here as the rationale should it ever be
  reconsidered as a separate, deliberate feature.

## 2026-07-16 — Phase 7 (t01 implemented, reviewed, committed)

- t01 PASS (coder + security). Spec was silent on scratch-dir creation-failure handling;
  implementer added a `try/catch` (console.error, leave `scratchDir` undefined) matching the
  surrounding completeness-floor idiom — sound gap-fill, t02 treats undefined as "omit".
- Deferred/known: **scratch-dir cleanup** — a new `picc-scratch-*` dir per session is never
  removed (Claude Code also leaves scratchpad dirs; retention is #41). Disk-hygiene follow-up
  candidate — consider a process-exit best-effort `rmSync` or fold into #41.
- Forward note for t02 review: `toNativeSafeTempForm` blindly converts backslashes on win32;
  if `realpathSync` ever returns an extended-length `\\?\C:\…` or UNC `\\server\share` form,
  the result is `//?/…` / `//server/…` — check t02's namespace-agreement holds (low
  likelihood: Node strips `\\?\` for ordinary temp paths).

- t02 reviewed: coder PASS; parity + UX both NEEDS-WORK, convergent on guidance strength.
  The parity agent could observe Claude's actual scratchpad section verbatim — the first
  draft softened Claude's emphatic "IMPORTANT: Always use…" and dropped the "only use /tmp
  if the user explicitly requests it" escape hatch. UX (MUST) caught that the "follow a
  skill's explicit path instructions" exception was too wide — a GPT model could read
  evaluate's vague "OS-temp path" as an override and reproduce #48 — and (SHOULD) that the
  recipe only covered `mktemp -p`, not the `>` redirect evaluate actually uses. Coordinator
  reworked the section: Claude-imperative lead-in, escape hatch, "scratchpad" vocabulary,
  redirect+Write+mktemp generalization, narrowed exception (defer only to a *specific
  literal path*), rationale-trails-directive, dropped "first attempt"/`cygpath` noise.
- Follow-up candidate (parity/UX): `examples/full-surface` has no scratch-dir-consuming
  skill; a fixture that writes to the injected scratchpad path would lock this parity
  surface against regression. Deferred → review.md.
- Deferred NIT (UX): the literal scratch path embeds the OS username and is re-injected each
  turn; a mild tension with evaluate echoing writes. Covered by evaluate's existing
  write-discipline (no absolute local paths in public writes, mechanic 3); not added to the
  injected guidance to avoid bloating it.

- t03 RAN (not skipped) and PASSED on the Windows dev machine — the real #48 witness is green.
  Spec correction: the pinned Pi SDK read `execute` destructures `{ path }`, NOT `{ file_path }`
  (my t03 spec said file_path). Production uses `path` end-to-end (the Pi read schema names it
  `path`; `file_path` is only the Claude-shaped alias the permission/hook layer matches on via
  tool-map), so there is NO production reliance on file_path reaching the read tool — the test
  passes both keys defensively. **Follow-up candidate:** if a Claude-authored skill instructs
  the model to call Read with `file_path`, does the Pi `read` execute accept it (it currently
  throws on file_path-only)? Likely a non-issue (the model follows the Pi tool's `path` schema),
  but worth a parity check → review.md.
- t03 discrimination note: the test proves the prescribed forward-slash drive-letter path works
  cross-tool first attempt, and a POSIX `/tmp/...` in the same structure WOULD fail the native
  Read (the real #48 mode). It does not separately discriminate forward-slash vs backslash for
  *inline* redirects (the path is passed via argv, not shell-parsed) — acceptable: the
  deterministic form-regression lives in t01's pure table, per the plan's test split.

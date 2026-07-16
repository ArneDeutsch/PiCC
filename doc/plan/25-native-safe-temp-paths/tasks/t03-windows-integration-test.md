# t03: Windows mixed-tool integration test (the #48 acceptance witness)

## Goal

An automated test proves the real mixed-tool route on Windows: a UTF-8 payload written
through PiCC's pinned Git Bash to a `toNativeSafeTempForm` path is read by the native Pi
Read tool **on the first attempt**, with matching content. It skips cleanly (not fails) on
Linux/macOS and on Windows boxes without Git Bash. This is the ticket's headline acceptance
criterion — testing either side alone would not reproduce the defect.

## Context & seams

- **New file:** `test/native-temp-paths.test.ts` (offline-integration layer).
- **Write side:** spawn the real pinned Git Bash via `resolveShellBinary("bash")`
  (`src/engine/shell-inject.ts:192`) and redirect a known UTF-8 string into a file under a
  `mkdtempSync` scratch dir you own, addressing it with the harness form produced by
  `toNativeSafeTempForm(fs.realpathSync(dir), "win32")` (from t01 — realpath the dir first,
  matching the production sequence; GitHub runners' `os.tmpdir()` can be an 8.3 form). Use
  `mktemp -p` inside that dir to mirror the real recipe, or write a fixed name you created —
  either is fine as long as the path handed to Read is the native-safe form.
- **Write must COMPLETE before the read.** Run the Git Bash write with `execFileSync`
  (as the `BASH_AVAILABLE` probe at `e2e-live-pi.test.ts:215` does) or await the child's
  `'exit'` — never fire an async `spawn` and read concurrently, or the file may be empty/
  partial or still hold an open write handle (Windows share violation) → intermittent red on
  the one test that IS the acceptance criterion.
- **Read side:** call the real Pi native read tool as `src/index.ts:953` wires it — the
  factory takes a **cwd string**, not a thunk: `const tool = sdk.createReadTool(cwd); await
  tool.execute(id, { file_path }, signal, onUpdate, CTX)` with the 5-arg shape used at
  `test/search-tools-rg.test.ts:30-34` (`CTX = {} as never`). `createReadTool` is on the
  pinned SDK surface (`test/pi-contract.test.ts:19`). There is no existing wrapper — call the
  factory directly like index.ts does.
- **Assert:** the read result contains the exact UTF-8 payload, on the first call (no retry,
  no search). Optionally assert the payload survives non-ASCII (a UTF-8 correctness nod,
  complementary to the existing UTF-16 discipline).

## Writable surface

- `test/native-temp-paths.test.ts` (new)
- No production code.

## Approach constraints

- **Gating:** `it.skipIf(process.platform !== "win32" || !hasBash)(...)`, where `hasBash`
  is probed once from `resolveShellBinary("bash")` — reuse the `BASH_AVAILABLE` idiom at
  `test/e2e-live-pi.test.ts:212-222`. CI runs `windows-latest` for `test:unit`
  (`.github/workflows/ci.yml`), so this genuinely executes there; it is a no-op skip on the
  ubuntu leg.
- **No integration-layer negative assertion.** Do NOT assert that reading the raw `/tmp/...`
  string fails — Git Bash `/tmp` mounts vary by install and native leading-slash resolution
  is environment-dependent, so that flakes. The deterministic anti-`/tmp` regression lives
  in t01's pure-logic table.
- **CI silent-skip reliance (document it).** `windows-latest` ships Git for Windows so this
  runs there, but it is the SOLE automated #48 witness; if that image ever drops Git Bash it
  skips green with no signal. Add a comment noting the reliance (a CI meta-assert that the
  witness actually executed on the win leg is optional but welcome).
- **Cleanup:** own your scratch dir via `mkdtempSync`; in `afterEach`, `fs.rmSync(dir,
  { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })` — the retries matter on
  Windows for lingering Git-Bash file handles (`test/e2e-live-pi.test.ts:37-49`). Never
  delete outside the dir you created.

## Left open

- Whether to also add one e2e scenario (parent `bash` writes, subagent `Agent` turn issues
  `read`) in `test/e2e-live-pi.test.ts` (patterns at `:472`, `:519`, `:626`). **Optional /
  probably skip** — the native Read is identical in the subagent path, so the offline
  integration test already proves the path-resolution contract; add e2e only if a reviewer
  argues the subagent routing itself is part of the contract.

## Testing

- This task *is* the test. Verify it passes on this Windows dev machine (it should actually
  run here, not skip). Confirm it skips (green, not failed) when the platform predicate is
  false — you can sanity-check the skip logic by reasoning/`it.skipIf`, not by faking the OS.

## Acceptance criteria
- [ ] `test/native-temp-paths.test.ts` exercises real Git Bash write → real
      `createReadTool` read, asserting first-attempt success with matching UTF-8 content.
- [ ] Correctly gated: runs on win32+GitBash, skips (not fails) otherwise.
- [ ] Cleans up its own scratch dir with the Windows-safe rmSync retry pattern.
- [ ] Passes on this Windows machine; typecheck and full suite green.

## Depends on
t01

# t02: System-prompt scratchpad injection (literal path, all platforms + Windows note)

## Goal

The harness injects a scratchpad section into the system prompt every turn — on **all
platforms** (mirroring Claude Code) — naming the per-session scratch dir by its **literal
resolved path** and telling the model to use it for temp files instead of `/tmp`. On Windows
(when the harness detects the Git-Bash↔native namespace split) an additional short note
prescribes the safe `mktemp -p` recipe and explains why a bare `/tmp` fails. Off-Windows the
only new content is the platform-neutral scratchpad line; all pre-existing sections stay
byte-for-byte unchanged.

## Context & seams

- **Detection predicate (injectable).** Add an exported predicate to
  `src/engine/shell-inject.ts` alongside `resolveGitBashPath` (lines 229-233):
  `shellNamespaceDiffersFromNative(platform?: NodeJS.Platform): boolean` ⇒
  `(platform ?? process.platform) === "win32" && resolveGitBashPath() !== undefined`.
  Take `platform` as an injectable param (like `toNativeSafeTempForm`) so BOTH branches are
  unit-testable without faking the real OS. It fires only when a real Git Bash is pinned —
  deliberately excluding bare-`bash`/WSL (different namespace; the mixed-form fact is false
  there). Uses the cached `resolveGitBashPath`, so it's free on the per-turn hot path.
- **Threading the value.** `buildSystemPromptSuffix` (`src/runtime/context-assembly.ts:121`)
  must NOT import from `engine/`. Add optional fields to `AssemblyInputs`, computed once in
  `index.ts` (the composition root, which already imports `shell-inject.ts` at line 56) and
  passed at the call site — mirroring how **`steeringText` and `autoMemory`** are threaded at
  `index.ts:1013-1014` (NOTE: do **not** copy `compatNotice` as a precedent — it is declared
  in `AssemblyInputs` but never passed at any call site; it is dead wiring):
  - `scratchDir?: string` (the literal native-safe path held from t01),
  - `windowsTempNote?: boolean` (= `shellNamespaceDiffersFromNative()`).
- **Injection.** In `buildSystemPromptSuffix`, push a new section when `scratchDir` is set.
  Do **not** mutate the `HARNESS_CONVENTIONS` const (existing anti-regression tests
  `toContain` its substrings — `test/runtime-core.test.ts:208-214`,
  `test/builtin-agents.test.ts:165`). A separate pushed section keeps the join identical for
  every other input. Section content:
  - **Always (when `scratchDir` set):** the faithful Claude-scratchpad directive naming the
    **literal resolved path** (e.g. "Use this per-session scratch directory for temporary
    files instead of `/tmp`; it is session-specific and isolated from the project:
    `<scratchDir>`"). It MUST name the literal path (this is Claude's actual contract — a
    Claude-authored skill expects to read the path from the prompt); do NOT phrase it as an
    env-var reference.
  - **When `windowsTempNote` is true, append the Windows note.** Constraints (wording is
    load-bearing — the note claims safety that only holds if the model follows it exactly):
    1. Prescribe `mktemp -p "<scratchDir>"` (quoted) as **mandatory and inseparable** — not
       a bare "use mktemp" (dropping `-p` lands back in `$TMPDIR`/`/tmp` and silently breaks
       the note's own premise).
    2. Bind creation to the scratch dir only — never `$TEMP`/`$TMP`, never `cygpath`.
    3. Keep the **why** clause: a bare `/tmp/...` is resolved drive-relative by the native
       Read/Grep/Glob tools and will not be found — the forward-slash drive-letter scratch
       path is resolved identically by the shell and the native tools.
    4. Frame the scratch dir as the **preferred/default** temp location, not an override of
       a skill's explicit instructions (avoids colliding with HARNESS_CONVENTIONS's "follow
       the skill exactly").

## Writable surface

- `src/engine/shell-inject.ts` (add `shellNamespaceDiffersFromNative(platform?)`)
- `src/runtime/context-assembly.ts` (extend `AssemblyInputs`; push the scratchpad section)
- `src/index.ts` (compute the two inputs; pass them at the `buildSystemPromptSuffix` call,
  `~index.ts:1005-1016`)
- `test/runtime-core.test.ts` (or a focused new test) for injection behavior
- No other files.

## Approach constraints

- Off-`win32`: the scratchpad line still appears (cross-platform parity — the maintainer's
  chosen scope, and verified as Claude's real all-platform behavior), but the Windows note
  does NOT, and no other section changes.
- Known limitation (state, don't fix): on win32 the scratch path is the forward-slash
  drive-letter form; a Windows+WSL bash (which the harness does not pin) resolves it in the
  wrong namespace — consistent with the harness pinning Git Bash and with Claude Code's own
  behavior. The predicate correctly withholds the *note* there; the always-on line still
  names a `C:/…` path, accepted as a known limitation.

## Left open

- Exact wording of the scratchpad line and the Windows note (implementer drafts within the
  constraints above; `user-experience`/`docs`/`claude-parity` refine in review). No leak of
  absolute local paths into any *public* write is a separate concern owned by evaluate — the
  system-prompt path itself is context, not a public artifact (Claude injects it too).
- Placement of the section among the optional sections — anywhere that keeps off-Windows
  non-scratchpad output unchanged.

## Testing

- **Injection present (all platforms):** with `scratchDir` set, the suffix contains the
  literal path and the "instead of /tmp" directive.
- **Windows note conditional:** with `windowsTempNote: true` the `mktemp -p`/forward-slash
  note appears; with `false` it does not. Force both branches by passing the flag directly.
- **Predicate both branches:** using the injectable `platform` param, assert
  `shellNamespaceDiffersFromNative("linux") === false` and (on win32-capable logic) the
  win32 branch — so a regression that makes it true off-Windows fails a red test (tester
  finding: today nothing asserts the predicate's off-win32 value).
- **Off-Windows unchanged (lock the property):** with `scratchDir` undefined, assert the
  existing sections join byte-for-byte as before, and add the currently-missing assertion
  that the Windows note is ABSENT. Existing `toContain("Claude Code compatibility
  conventions")` assertions still pass.
- Unit layer; no disk, no shell.

## Acceptance criteria
- [ ] `shellNamespaceDiffersFromNative(platform?)` exported, injectable, exact
      `win32 && resolveGitBashPath()!==undefined` predicate; both branches tested.
- [ ] Scratchpad section injected on all platforms when `scratchDir` set, naming the LITERAL
      path; Windows note gated on the predicate with the four wording constraints.
- [ ] `HARNESS_CONVENTIONS` const unchanged; existing conventions assertions still green.
- [ ] Off-Windows output has no Windows note; tests lock this and the predicate's off-win32
      value.
- [ ] typecheck and full test suite green.

## Depends on
t01

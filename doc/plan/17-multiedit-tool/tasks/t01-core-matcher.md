# t01: MultiEdit core matcher module + tool factory + unit tests

## Goal

A self-contained `src/runtime/tools/multi-edit.ts` exports
`createMultiEditTool(getCwd: () => string): ToolDefinition` — a real, atomic,
sequential multi-edit tool — plus a passing unit suite `test/multiedit.test.ts`.
The tool is **not yet wired into any session** in this task (that is t02), so the
whole test suite stays green: nothing references the new module except its test.

## Context & seams

- **Factory shape (contract with t02 — must match exactly):**
  `createMultiEditTool(getCwd: () => string): ToolDefinition`, built with
  `defineTool` from `@earendil-works/pi-coding-agent`. Mirror the convention in
  `src/runtime/tools/search-tools.ts` (`createGlobTool`, line ~782): a `getCwd`
  thunk resolved **at execute time**, `name`/`label` = `"MultiEdit"`, returns
  `{ content: [{ type: "text", text }], details: {...} }`, and **throws `Error`**
  on any failure (Pi turns a throw into an `isError` result → the guard fires
  `PostToolUseFailure` and the message reaches the model). Do **not** `return` a
  notice the way the degrade stubs do.
- **Parameter schema (Claude MultiEdit shape — t02's tests and the permission
  engine depend on `file_path`):**
  - `file_path: string` (required)
  - `edits: Array<{ old_string: string; new_string: string; replace_all?: boolean }>`
    (required, at least one element)
- **Path resolution — MUST use plain `path.resolve(getCwd(), file_path)`.** Do
  **not** adopt Pi's `resolveToCwd` / any `~`, unicode-space, `@`-prefix or
  `file://` expansion: the permission guard matches deny rules on the plain
  resolution, so any divergent transform is a path-scoped-deny bypass (security
  MUST). Absolute `file_path` is used as-is by `path.resolve`.
- **Concurrency — MUST reuse the exported `withFileMutationQueue`** from
  `@earendil-works/pi-coding-agent` (it is on the public surface). Wrap the entire
  read→compute→write in `withFileMutationQueue(absPath, async () => { ... })`; it
  keys on `realpath`, so this serializes MultiEdit against concurrent Edit/Write/
  MultiEdit on the same file (Pi's `edit` and `write` both use it).
- **Encoding/line-ending handling** (reimplement — Pi's helpers are private):
  strip a leading UTF-8 BOM (`﻿`) before matching and re-prepend it on write;
  detect the file's line ending (first `\r\n`-vs-`\n` wins), normalize the buffer
  to LF for matching, and restore the detected ending on write (all `\n` → the
  detected ending). This keeps a CRLF file from churning every line on Windows.
  **Guard the CRLF-in-`new_string` double-convert:** a `new_string` may itself
  contain a literal `\r\n`; inserting it into the LF buffer and then running the
  `\n`→`\r\n` restore would produce `\r\r\n`. Normalize the **composed** buffer to
  LF once (or normalize each `new_string` on insert) **before** restoring line
  endings. On the **file-creation** path there is no pre-existing ending to detect
  — write the composed buffer verbatim (no EOL restoration).
  The `generateDiffString` / `generateUnifiedPatch` formatters **are** public if a
  `details.diff`/`patch` is wanted — optional, not required.
- **A model-facing `description` is required** by `defineTool`. Author one that
  describes the sequential/incremental all-or-nothing semantics; do **not** reuse
  Pi Edit's "matched against the original file" wording (MultiEdit is deliberately
  sequential, not against-original).
- **All input validation lives in `execute()`, not only the schema.** The unit
  harness calls `.execute()` directly, bypassing typebox — so the empty-`edits`
  guard and every other check must be a runtime guard inside `execute` (as Pi's
  `validateEditInput` does), not merely a schema `minItems`.
- **Abort discipline** (security/coder MUST): check `signal?.aborted` after each
  `await` (after the read, before the write) and throw `"Operation aborted"`; do
  **not** attach an abort *listener* that rejects (it would release the mutation
  queue mid-op). Mirror Pi `edit.js`'s `throwIfAborted()` pattern.

## Approach constraints (the authentic historical MultiEdit contract)

Apply edits **sequentially to a single in-memory running buffer** (edit N sees the
result of edit N−1), then write **once** at the very end. If any edit fails, throw
**before** the single write — the file is left byte-untouched (atomic).

Per edit, matched against the **current running buffer** (LF-normalized):
- **Exact** substring match only — NO fuzzy/smart-quote/dash/whitespace
  normalization (deliberate divergence from Pi's `edit`; more faithful to Claude).
- `replace_all !== true`: the match must be **unique** — 0 occurrences → "not
  found" error; >1 → "not unique / ambiguous" error. Exactly 1 → replace it.
- `replace_all === true`: replace **every** occurrence in the buffer; 0
  occurrences is still a "not found" error.
- `old_string === new_string` → error (must differ). `new_string === ""` is a
  **valid deletion** — do not reject it.
- **Empty `old_string` = file creation**, and only in the create case: allowed
  **only** as the **first** edit when the target file does **not** exist — the
  buffer starts as `new_string`; subsequent edits then apply to that buffer. An
  empty `old_string` on an existing file, or as any non-first edit, is an error.
- File does not exist and the first edit's `old_string` is non-empty → a clear
  file-not-found error.
- Empty `edits` array → a clear error.

Error messages must be model-actionable (name the file and, for multi-edit
batches, which edit index failed and why), in the spirit of Pi's edit errors.

Keep the module free of session/index coupling — it takes only `getCwd`.

## Writable surface

- `src/runtime/tools/multi-edit.ts` (create)
- `test/multiedit.test.ts` (create)

Everything else is read-only in this task.

## Left open (implementer decides)

- Exact wording of error/success strings and whether to populate `details.diff`
  via the public `generateDiffString`.
- Sync vs. async `fs` (async + `throwIfAborted` after awaits matches Pi and keeps
  abort responsive; either is acceptable if the abort/queue discipline holds).
- On the **file-creation** path, whether to write the created buffer verbatim (no
  EOL restoration, since there is no pre-existing ending to preserve) — the
  reasonable default; document the choice inline.
- Internal helper factoring (a pure `applyEdits(buffer, edits)` core is encouraged
  for direct unit testing).

## Testing

`test/multiedit.test.ts` (unit / Layer 1). Reuse the harness header pattern from
`test/search-tools-params.test.ts` (a `CTX = {} as never` and a `run(tool, params)`
that calls `tool.execute("t", params, undefined, undefined, CTX)`; `mkTmpDir` via
`fs.mkdtempSync(path.join(os.tmpdir(), ...))`; `afterEach` cleanup). Construct
`createMultiEditTool(() => dir)` and call `.execute` directly against temp files —
no model, no SDK. Write fixtures with **explicit byte literals** (`"\r\n"`,
`"﻿"`) so the same bytes land on Windows and Linux; do **not** commit fixtures
and do **not** `skipIf(isWindows)` the encoding cases (they must pass on both).

Cover: (1) sequential application (edit 2 matches text produced by edit 1; assert
final bytes); (2) atomic rollback on a later edit failing (snapshot bytes before →
reject → file byte-identical); (3) rollback when edit 1 succeeds and edit 2 is
ambiguous (no partial write); (4) uniqueness failure without `replace_all`;
(5) `replace_all` replaces all occurrences (+ a non-`replace_all` edit in the same
call stays single-match); (6) absent `old_string` — with `replace_all` false **and**
with `replace_all` true (0 occurrences is still a "not found" error either way);
(7) empty `edits` array; (8) file-not-found; (9) BOM preserved; (10) line-ending
handling — a uniform-CRLF file stays CRLF and a uniform-LF file stays LF on
untouched lines; a genuinely **mixed**-EOL file **collapses to the detected
ending** (the documented, Pi-matching restore behavior — assert that, not "no
normalization"); (11) `old == new` rejected; (12) relative vs. absolute `file_path`
resolving against the injected `getCwd`; (13) file creation via empty `old_string`
first edit on a nonexistent file (+ empty `old_string` on an existing file is an
error, **+ empty `old_string` as a non-first edit is an error** even while creating);
(14) `new_string=""` deletion succeeds; (15) a `new_string` containing `\r\n` in a
CRLF file does **not** become `\r\r\n` (the composed-buffer normalization above);
(16) **abort discipline** — a pre-aborted `AbortController().signal` makes `execute`
throw and leaves the file byte-unchanged (no write); (17) **path-resolution
security negative** — a `file_path` like `"~/x"` or `"file://x"` is resolved
**literally** via `path.resolve(getCwd(), ...)` (assert the resolved target, so a
future switch to `resolveToCwd`'s `~`/`file://` expansion would fail this test).

Do **not** write a fixture whose `old_string` contains a literal `\r\n` expecting a
match against a CRLF file — the buffer is LF-normalized for matching (Pi-matching),
so such an `old_string` won't match; that is by design, not a bug.

## Acceptance criteria

- [ ] `src/runtime/tools/multi-edit.ts` exports `createMultiEditTool(getCwd): ToolDefinition` with the schema and semantics above.
- [ ] All matching/atomicity/encoding rules hold, verified by `test/multiedit.test.ts`.
- [ ] Uses the exported `withFileMutationQueue`; resolves paths with plain `path.resolve(getCwd(), file_path)` (no `resolveToCwd` transforms).
- [ ] typecheck and full test suite green.

## Depends on

–

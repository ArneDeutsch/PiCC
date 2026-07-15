# t02: Wire NotebookRead into the runtime, retier the registry, update drift guards

## Goal

The real `NotebookRead` tool (from t01) is registered into the runtime as a real tool,
removed from the degraded-stub set, retiered in the capability registry to `partial`, the
capability matrix is regenerated, and every drift-guard test that referenced the old
degraded entry is updated. After this task `NotebookRead` is a live real tool for both the
coordinator session and (gated) subagents, and typecheck + full suite are green.

## Context & seams

Consumes t01's factory: `createNotebookReadTool(getCwd: () => string): ToolDefinition`
from `src/runtime/tools/notebook-tools.ts`.

**Wiring (src/index.ts):**
1. Import `createNotebookReadTool` near the other tool imports (~`src/index.ts:39-40`).
2. Add `createNotebookReadTool(get)` to the `buildCwdBoundTools` return array
   (`src/index.ts:523-533`), alongside `createWebFetchTool(get)` etc. — **not** into the
   `DEGRADED_TOOLS.map(...)` line. This automatically provisions it to the main session
   (`src/index.ts:758`) and, gated by grant, to subagents (`customToolsFor`,
   `src/index.ts:665-668`).
3. Add the literal string `"NotebookRead"` to the hard-coded real-tool list in
   `allKnownToolNames()` (`src/index.ts:628-654`, alongside `"Read"`, `"Write"`, …).
   **Critical:** today `NotebookRead` is "known" only via the `...DEGRADED_TOOLS.map(d =>
   d.name)` spread (line ~652); once it leaves `DEGRADED_TOOLS`, without this literal a
   project's `tools: [NotebookRead]` grant or a `NotebookRead(...)` permission rule would
   treat it as an unknown tool and gate it out.

**Route path-scoped permission rules (MUST — else a `NotebookRead(<glob>)` deny silently
never matches).** In `src/engine/permissions.ts`, the `matchesRule` switch (~:556-583)
routes `Read`/`Edit`/`Write`/`MultiEdit`/`NotebookEdit`/`Glob`/`Grep` to
`pathSpecifierMatches` but has **no `NotebookRead` case**, so a rule like
`deny: ["NotebookRead(./secrets/**)"]` falls into `default` (which matches against
`input.command ?? input.file_path ?? input.url`, all absent for NotebookRead) and never
fires. Today that's harmless (the stub reads nothing); once NotebookRead is a real reader
with the same trust boundary as `Read`, a silently-ignored path deny is a permission-
integrity gap. Add `case "NotebookRead":` alongside the other path tools (~:561-568) so it
routes to `pathSpecifierMatches`. The infrastructure is already in place —
`notebook_path` is in `CANONICAL_INPUT_FIELDS` (~:495-505) and `pathSpecifierMatches`
already reads `call.input["notebook_path"]` (~:403) — only the switch case is missing.
(NotebookRead stays **out** of `FILE_EDIT_TOOLS` — it is read-only.)

**Remove the stub:** delete the `NotebookRead` entry from `DEGRADED_TOOLS`
(`src/runtime/tools/degrade-stubs.ts:41-43`). Leave `NotebookEdit` untouched.

**Retier the registry (`src/registry/capability-registry.ts`):** change the
`tool.NotebookRead` entry (line ~64) from `degraded-noop` to **`partial`**, and move the
`cap(...)` line up out of the degrade-stub comment block into the real-tool group (near
`tool.Read`/`tool.Grep`/`tool.TaskOutput`). New entry (one line, no newlines — the note
must be a single line or `registry.test.ts` rejects it):

```
cap("tool", "tool.NotebookRead", "partial", "real implementation — parses the .ipynb JSON and presents each cell's source + outputs (stream / text/plain / error traceback); PARTIAL: image outputs are noted by mime-type + approximate size, not rendered visually; oversized text outputs are head-truncated; single-cell selection (cell_id) is not supported (§4.8)"),
```

(Note precision matters — the two degrades differ: images are *noted* (content dropped),
oversized text is *head-truncated* (content kept but bounded). Don't conflate them, and
name the `cell_id` omission — it's a second real reason the tier isn't `full`. Keep it one
line; `registry.test.ts` rejects newlines in notes.)

Keep `safetyRelevant` as it is for the other read tools (false / omitted — read-only).

**Regenerate the matrix:** run `npm run gen:capabilities` (→ `node
scripts/gen-capability-matrix.mjs`, writes `doc/supported-features.md`) and commit the
regenerated file. Do **not** hand-edit `doc/supported-features.md` — the freshness guard
(`test/registry.test.ts:445-457`) diffs it byte-for-byte (CRLF-normalized) against the
in-process render.

**Drift-guard test updates:**
- `test/tools-parity.test.ts:300-312` — remove the `"NotebookRead"` literal from the
  `arrayContaining([...])` "degraded tool names" assertion (the loop below it iterates
  `DEGRADED_TOOLS` and self-adjusts).
- `test/registry.test.ts` sync test (~:341-370) — direction B asserts every
  `degraded-noop` registry entry has a shipping stub; retiering to `partial` keeps it
  green. **Add** positive assertions mirroring the SlashCommand/TaskOutput precedent
  (~:358-366): `expect(lookupCapability("tool.NotebookRead")?.tier).toBe("partial")` and
  `expect(stubNames.has("NotebookRead")).toBe(false)`.
- `test/integration-extension.test.ts:43-64` — add `"NotebookRead"` to the registered-
  surface list so the offline-integration layer proves it's wired as a real tool. (The
  "registers degrade stubs" case at ~:66-72 uses `AskUserQuestion` and is unaffected.)
- `test/registry.test.ts:706-729` — the skill `disallowedTools: ["NotebookRead"]` case
  still asserts no compat finding (denying a `partial` tool is legitimate, so the
  assertion stays green), but its inline comment rationale ("denying a degraded tool …")
  is now wrong — update the comment to reflect that NotebookRead is a real `partial` tool.
- **Do NOT** add `NotebookRead` to the "core tool surface as full" list at
  `test/registry.test.ts:183-193` — that list is for `full` tools; NotebookRead is
  `partial`.
- **Guard the `allKnownToolNames` wiring with a test that actually fails if the literal is
  missing.** A compat-report test (`registry.test.ts:608-622`) routes tool names through
  `lookupCapability`/the registry — NOT through `allKnownToolNames()`/`gateTools` — so it
  passes whether or not the literal is added (NotebookRead is already a registry entry).
  That would leave the self-identified "Critical" wiring **untested**. Instead mirror the
  F11 precedent `test/slashcommand-fork.test.ts:79-109` (offline-integration layer):
  dispatch a subagent granted `tools: [NotebookRead]` (or all-tools) and assert a
  `NotebookRead` customTool actually reached the created subagent session (via the fake-pi
  `created`/`customTools` inspection that test uses). This fails iff the `allKnownToolNames`
  literal is absent (`gateTools` filters the grant against `allKnown`, so a missing name
  silently drops the tool from the subagent). (A lighter alternative, if preferred: export
  `allKnownToolNames` and unit-assert `gateTools(["NotebookRead"], undefined,
  allKnownToolNames())` yields the tool — but the dispatch test matches precedent and needs
  no source-surface change.)
- **Guard the permission-switch fix:** add a `matchesRule`/permission test that a
  path-scoped `NotebookRead(<glob>)` rule matches a call whose `notebook_path` is under the
  glob (and does NOT match one outside it) — proving the new switch case routes through
  `pathSpecifierMatches`. Mirror the existing NotebookEdit/Read path-rule tests in
  `test/permissions*.test.ts`.

## Writable surface

- `src/index.ts` (wiring + `allKnownToolNames`)
- `src/engine/permissions.ts` (add the `NotebookRead` case to the `matchesRule` switch)
- `src/runtime/tools/degrade-stubs.ts` (remove entry)
- `src/registry/capability-registry.ts` (retier + reposition)
- `doc/supported-features.md` (regenerated only — never hand-edited)
- `test/tools-parity.test.ts`, `test/registry.test.ts`, `test/integration-extension.test.ts`,
  and a permission path-rule test + the subagent-dispatch wiring test (new cases; place in
  the matching existing files, e.g. `test/permissions*.test.ts` and a dispatch test
  mirroring `test/slashcommand-fork.test.ts`)
- Do NOT touch `src/runtime/tools/notebook-tools.ts` or `test/notebook-read.test.ts` (t01).

## Approach constraints

- Tier is `partial` (decided with the user; image outputs noted not rendered).
- Regenerate `doc/supported-features.md` via the npm script; never hand-edit it.
- No `--no-verify`; the pre-commit hook runs the suite.

## Left open

- Exact placement of the `NotebookRead` literal within the `allKnownToolNames` list and
  the `buildCwdBoundTools` array (keep it near the other read/real tools) — your call.

## Testing

No new test file; this task **updates** existing drift-guard tests as enumerated above and
adds the two positive assertions (tier `partial` + not-a-stub; known-tool grant). Run the
full suite; the freshness guard passing confirms the matrix was regenerated.

## Acceptance criteria
- [ ] `NotebookRead` removed from `DEGRADED_TOOLS`; real tool added to `buildCwdBoundTools`
      and to `allKnownToolNames()`.
- [ ] `NotebookRead` case added to the `matchesRule` permission switch (path-scoped rules match).
- [ ] `tool.NotebookRead` registry tier is `partial` with the new note; matrix regenerated.
- [ ] All enumerated drift-guard tests updated; a subagent-dispatch test proves the
      `allKnownToolNames` wiring, and a permission path-rule test proves the switch case.
- [ ] typecheck and full test suite green.

## Depends on
t01

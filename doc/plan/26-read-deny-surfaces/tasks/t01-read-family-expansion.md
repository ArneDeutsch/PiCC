# t01: Read-family deny expansion + tests + code doc-comments

## Goal

A permission rule whose tool part is `Read` (e.g. `deny: Read(secrets/**)`) also
matches `Grep`, `Glob`, and `NotebookRead` calls that target a matching path — the
same way an `Edit` rule already matches the whole file-edit family. One-directional: a
`Grep`/`Glob`/`NotebookRead` rule still does NOT gate a `Read` call. Deny stays a hard
block. typecheck + full suite green.

## Context & seams

All in `src/engine/permissions.ts`. The existing edit-family expansion is the exact
model to mirror:

- `FILE_EDIT_TOOLS` set (~line 112) + one line in `ruleToolMatches` (~lines 120-123:
  `return ruleTool === "Edit" && FILE_EDIT_TOOLS.has(callTool);`).

The change:

- Add `const FILE_READ_TOOLS = new Set(["Read", "Grep", "Glob", "NotebookRead"]);`
  next to `FILE_EDIT_TOOLS`.
- In `ruleToolMatches`, add a second expansion clause so it reads (keeping the existing
  `toolNameMatches` and `Edit` clauses):
  ```ts
  if (toolNameMatches(ruleTool, callTool)) return true;
  if (ruleTool === "Edit" && FILE_EDIT_TOOLS.has(callTool)) return true;
  return ruleTool === "Read" && FILE_READ_TOOLS.has(callTool);
  ```

**No other logic change is needed and none should be added.** Verified during planning:

- The `matchesRule` switch (~lines 556-569) dispatches on `rule.tool`. With a `Read`
  rule, once `ruleToolMatches` returns true the dispatch hits the `"Read"` case →
  `pathSpecifierMatches`, which already reads `file_path ?? path ?? notebook_path`
  (~line 403). Grep/Glob supply `path`; NotebookRead supplies `notebook_path`. So the
  path-extraction infrastructure is already correct — do NOT touch the switch or
  `pathSpecifierMatches`.
- `CANONICAL_INPUT_FIELDS` already contains `path` and `notebook_path`.

**Coupling consequences — these are INTENDED and must be preserved (do not decouple):**

- `denyRemoves` in `PermissionEngine.gateTools` (~lines 727-731) reuses
  `ruleToolMatches`. So a **bare** `deny: Read` (no specifier) now strips
  Grep/Glob/NotebookRead from an agent/skill tool context — exactly mirroring bare
  `deny: Edit`. The `rule.specifier !== ""` guard (~line 729) already ensures a
  **scoped** `Read(glob)` deny removes nothing from context. This coupling keeps the
  advertised toolset and the enforced reality in agreement; keep it.
- `ruleToolMatches` is used symmetrically for deny/**ask/allow** in `evaluate()`, so the
  widening applies to all three directions — not only deny. Under PiCC's
  default-permissive posture ask is `degraded-noop` (never prompts) and allow is moot,
  so this is functionally inert for those directions, but name it so a future reader
  knows the expansion is not deny-only.
- `matchesRule` is also imported by `guard.ts` (extra-deny co-enforcer) and the hooks
  `if:` engine. The read-family widening therefore also applies to skill `Read(...)`
  deny rules and hook `if: Read(...)` conditions — again consistent with the existing
  Edit-family behavior. NB: the hook `if:` field is a **PiCC-only extension** (Claude's
  hook `matcher` is separate and untouched), so this coupling creates no Claude-parity
  divergence — frame it that way in the log/doc-comment.

Security review confirmed the change is **strictly monotonic**: it can only ADD
deny-matches, never remove one, so it cannot weaken any existing deny. `grantMatches`
(the only tool-ADDING path in gateTools) uses `toolNameMatches`, not `ruleToolMatches`,
and must stay untouched.

## Writable surface

- `src/engine/permissions.ts` (the two-line logic change + doc-comment updates below).
- `test/permissions-hardening.test.ts`, `test/permissions.test.ts`,
  `test/runtime-core.test.ts` (new/extended test cases).
- `doc/plan/26-read-deny-surfaces/log/t01.md` (execution log).

Everything else is read-only.

## Approach constraints

- Mirror the Edit-family style exactly; no broader refactor of the matcher.
- Update the two contract doc-comments so the text matches behavior:
  - the `ruleToolMatches` JSDoc (~lines 114-119) — note the `Read` = all file-read
    tools expansion alongside the `Edit` one, and that it is one-directional.
  - the `gateTools` JSDoc (~lines 709-714, which currently says "a bare `Edit` deny
    removes all file-editing tools") — add the parallel bare-`Read` sentence.
  - On `FILE_READ_TOOLS`, a one-line comment noting Grep/Glob are documented Claude
    parity and NotebookRead is included as inferred defense-in-depth (Claude's docs do
    not name it).

## Left open

- Exact wording of the doc-comments and test names (match surrounding conventions).
- Whether to also add a read-family entry to the malformed-rule never-throw list
  (optional, cheap).

## Testing

Mirror the existing Edit-family tests precisely. Layer: **unit only** — the two
consumers (`matchesRule`/`evaluate` and `gateTools`) fully prove the contract; no new
e2e/integration is warranted (see t02 note on the existing fixture).

In `test/permissions-hardening.test.ts`, new `describe("Read rules gate all file-read
tools")` modeled on **"Edit rules gate all file-modification tools"** (~lines 46-95),
using the shared `denyEngine([...])` / `call()` helpers:

1. `deny: Read(secrets/**)` → `evaluate` returns `{decision:"deny", rule:"Read(secrets/**)"}`
   for: `Grep {path:"secrets/x"}`, `Glob {path:"secrets/sub"}`,
   `NotebookRead {notebook_path:"secrets/nb.ipynb"}` (mirror ~lines 49-63).
2. Non-matching path passes: `Grep {path:"src"}` → `default`. And `Read(secrets/**)`
   does NOT gate `Write`/`Edit` (proves the two family sets weren't unioned)
   (mirror ~lines 65-70).
3. One-directional (mirror ~lines 78-81): `matchesRule("Grep(secrets/**)",
   call("Read",{file_path:"secrets/x"}))` is `false`, with the positive control
   `matchesRule("Grep(secrets/**)", call("Grep",{path:"secrets/x"}))` `true`. Add at
   least one more (`Glob(...)` or `NotebookRead(...)` not gating Read).
4. **Directory-argument edge (pin observed behavior).** A `Glob`/`Grep` whose `path` is
   the bare protected directory itself (`{path:"secrets"}`, no subsegment) under
   `deny: Read(secrets/**)` — assert the ACTUAL matcher result rather than assuming it
   is blocked. `secrets/**` requires at least one segment under `secrets/`, so naming
   the directory to enumerate it is the natural Glob call that the glob may not cover.
   This is inherent glob semantics shared with the Edit family and Claude itself, not a
   divergence — the test documents the gap so it is not discovered later, and it is the
   concrete basis for the t02 honesty caveat.

In `test/permissions-hardening.test.ts` gateTools block ("gateTools removes
bare-tool-denied tools from context"): extend the `known` array (~line 298) to include
`Grep`, `Glob`, `NotebookRead`; add "a bare Read deny removes all file-read tools"
mirroring the bare-Edit test (~lines 307-314): bare `deny: ["Read"]` removes
Read/Grep/Glob/NotebookRead from context while leaving Bash/Edit/Write; and a **scoped**
`deny: ["Read(secrets/**)"]` removes **none** of them (proves the specifier guard).

Cross-platform (reuse the existing Read normalization blocks, one variant each — do not
duplicate the whole matrix):
- `test/permissions.test.ts` D2 block (~lines 199-243, runs on both OSes): one
  read-family drive-letter case, e.g.
  `matchesRule("Read(//c/**/.env)", call("Grep", {path:"C:\\proj\\.env"}))` → `true`.
- bare-filename any-depth: one case where `Read(.env)` gates a `Grep`/`NotebookRead`
  call whose path is `a/b/.env` (mirror ~lines 176-180).

Live-call wiring (unit): in `test/runtime-core.test.ts` `describe("tool-map")`
(~lines 90-116), add one assertion that `toClaudeCall("grep", {path:"secrets/x"}, cwd)`
yields `tool:"Grep"` with `file_path` populated (mirror the existing `read` case
~lines 104-107) — closes the "does a live grep reach the engine as a matchable Grep
call" gap. (NotebookRead passes through unmapped, keeping its Claude name and
`notebook_path`; no tool-map change needed for it — a one-line log note suffices.)

## Acceptance criteria
- [ ] `FILE_READ_TOOLS` added; `ruleToolMatches` expands `Read` one-directionally.
- [ ] `deny: Read(secrets/**)` blocks Grep/Glob/NotebookRead on matching paths; does
      not block non-matching paths or Write/Edit; Grep/Glob rules do not gate Read.
- [ ] bare `deny: Read` removes the read family from `gateTools` context; scoped
      `Read(glob)` removes none.
- [ ] Cross-platform drive-letter + bare-filename read-family cases pass.
- [ ] tool-map unit assertion for live `grep`→`Grep` present.
- [ ] `ruleToolMatches` + `gateTools` doc-comments updated to match behavior.
- [ ] typecheck and full test suite green.

## Depends on
–

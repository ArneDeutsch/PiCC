# t02: Wire MultiEdit into the runtime, retire the stub, retier the registry

## Goal

`MultiEdit` is a live, registered tool in both the main session and subagents,
gated and routed exactly like `Edit`; its degrade stub is gone; the capability
registry reports `tool.MultiEdit` as `full`; the generated support matrix is
regenerated; and the registry/integration tests prove registration, permission/
hook routing, and nested-context injection. Suite green.

These edits are a **single atomic step** — done together or tests break: removing
`MultiEdit` from `DEGRADED_TOOLS` while the registry still says `degraded-noop`
fails the drift guard, and retiering the registry without regenerating the matrix
fails the freshness test.

## Context & seams

Consumes t01's `createMultiEditTool(getCwd): ToolDefinition`.

Four load-bearing wiring edits (all verified against the code in Phase 4):

1. **`src/index.ts` — `buildCwdBoundTools` (~L518-534):** add
   `createMultiEditTool(get) as unknown as Record<string, unknown>` to the returned
   array (alongside the WebFetch/Grep/Glob/worktree/degrade entries). This single
   insertion reaches **both** the main session (registered unconditionally via the
   `pi.registerTool` loop, L911) **and** subagents (gated by `granted.includes("MultiEdit")`,
   L664-667). Do **not** add it to the `pi.registerTool` cwd-swap built-in-override
   block (L919-956, Pi built-ins only) and do **not** touch `PI_TO_CLAUDE` /
   `claudeToolsToPiBuiltins` (MultiEdit has no Pi built-in; it stays name-verbatim).
2. **`src/index.ts` — `allKnownToolNames()` (~L628-654):** add the literal
   `"MultiEdit"` to the returned array. It previously rode in via
   `...DEGRADED_TOOLS.map(...)`; once removed from `DEGRADED_TOOLS` it must be listed
   explicitly or `gateTools` treats a subagent `tools: [MultiEdit]` grant as unknown.
3. **`src/runtime/tools/degrade-stubs.ts`:** remove the `MultiEdit` entry from
   `DEGRADED_TOOLS` (L69-71). (Prevents a duplicate `"MultiEdit"` registration where
   the trailing no-op stub could shadow the real tool.)
4. **`src/runtime/tool-map.ts` — `touchedFilePath()` (~L81-88):** add `"MultiEdit"`
   to the `["Read","Write","Edit"]` list so on-touch nested-CLAUDE.md / path-scoped
   rule injection fires for MultiEdit (it reads `input.file_path ?? input.path`;
   MultiEdit uses `file_path`). Required for Edit-parity (defense-in-depth).

**No `permissions.ts` change** — `FILE_EDIT_TOOLS` already includes `MultiEdit`
(an `Edit(...)` rule already gates it) and `pathSpecifierMatches` already has a
`case "MultiEdit"`. Verified; leave it.

**Registry:** in `src/registry/capability-registry.ts` change the `tool.MultiEdit`
entry (L71) from `degraded-noop` to `full` with an honest note. Suggested note
(trim to house length; the load-bearing truths that MUST survive editing:
(a) the **baseline-removed hedge**, led with — `full` = faithful to the pre-removal
contract, NOT "matches current Claude Code"; (b) **strictly-exact** matching, said in
a way that does not read as equivalent to PiCC's `Edit` (whose Pi engine has a fuzzy
fallback); (c) sequential/atomic/replace_all/empty-old_string-creates):

> real implementation of the historical Claude Code MultiEdit — NOTE Claude Code
> 2.1.x removed the tool (about v2.0.8), so `full` means faithful to the pre-removal
> contract, a superset of the pinned baseline kept as an older-project compatibility
> courtesy: batched, **strictly exact-string** edits (no fuzzy fallback, unlike
> PiCC's Edit) applied sequentially to a running buffer (each edit sees the prior
> edit's result), atomic (any miss rejects the whole batch, file untouched), per-edit
> replace_all with unique-else-error, and an empty old_string on a new file creates it
> (§4.8)

Follow the existing note house convention (the `§4.8`-style section markers are used
throughout the registry — keep them; the "no shell metacharacters" ASCII rule applies
only to shell-passed titles/slugs, not to this TS string literal). Then **regenerate**
`doc/supported-features.md`: `npm run gen:capabilities`.

## Writable surface

- `src/index.ts`
- `src/runtime/tools/degrade-stubs.ts`
- `src/runtime/tool-map.ts`
- `src/registry/capability-registry.ts`
- `doc/supported-features.md` (regenerated output — do not hand-edit)
- `test/registry.test.ts`
- `test/integration-extension.test.ts`
- `test/runtime-core.test.ts`

Do **not** edit `examples/full-surface/**` — the tests below are constructed to
avoid needing any fixture change (see the Testing notes).

## Approach constraints

- Regenerate `doc/supported-features.md` with `npm run gen:capabilities`; never
  hand-edit it (the freshness test regenerates in-process and byte-compares).
- Keep the registry note factual and hedged (see the note guidance above); use the
  registry's existing `§`-marker convention, not forced ASCII.

## Left open

- Exact final wording of the registry note within the constraints above.
- Whether to add a tiny guard test that MultiEdit is in `allKnownToolNames()` (the
  integration registration assertion below already covers the observable effect).

## Testing

- **`test/registry.test.ts`:** add `"MultiEdit"` to the core full-tier tool list
  (~L184) so its tier is asserted `full`; add explicit drift assertions mirroring
  the SlashCommand/TaskOutput precedent (~L364-366):
  `expect(lookupCapability("tool.MultiEdit")?.tier).toBe("full")` and
  `expect(stubNames.has("MultiEdit")).toBe(false)`. (The existing sync loops already
  enforce this; the lines document intent.) The freshness test (~L446) must pass —
  i.e. `doc/supported-features.md` was regenerated.
- **`test/runtime-core.test.ts` (cheapest, deterministic proof of the `touchedFilePath`
  edit):** add a unit assertion near the existing `touchedFilePath` cases (~L118-122):
  `expect(touchedFilePath("MultiEdit", { file_path: "x.ts" })).toBe("x.ts")`. This is
  cross-platform and free of any shared-session ordering hazard — the primary proof
  that wiring edit #4 landed.
- **`test/integration-extension.test.ts`:** (a) add `"MultiEdit"` to the tool-surface
  registration list (~L43-64); (b) add an end-to-end **nested-injection** test — but
  **do NOT reuse the shared `beforeAll` `pi`**: its single nested-CLAUDE.md dir
  (`src/`, canary `FS-NESTED-SRC-CLAUDE-MD` + path-scoped `FS-RULE-RUST-PATHSCOPED`)
  is injected once-per-session and is already consumed by the existing first-touch
  read test (~L378-398). Instead build a **freshly-wired instance** (the
  `wire()` / `picc(freshPi.api, …)` pattern already used ~L549) so injection dedup
  state is fresh, and fire a `MultiEdit` `tool_call` on `src/main.rs` as that
  instance's **first** `src/` touch; assert `FS-NESTED-SRC-CLAUDE-MD` /
  `FS-RULE-RUST-PATHSCOPED` inject. This proves MultiEdit specifically flows through
  on-touch injection, end-to-end, with no fixture edit.
- **Do NOT add a deny-block integration test.** The fixture's deny rules
  (`Read(secrets/**)`, `Bash(curl *)`, `WebFetch(...)`) do not gate MultiEdit, and
  adding an `Edit(...)`/`MultiEdit(...)` deny rule means editing
  `examples/full-surface/**` (out of this task's surface) with ripple into the
  compat-count / startup-notice / doctor assertions. The MultiEdit permission
  **decision** is already proven at the cheapest layer in
  `test/permissions-hardening.test.ts` (deny `Edit(glob)` blocks MultiEdit; direct
  `MultiEdit(...)` path rules match) — rely on that plus the registration assertion.
- **Confirm-green (no edits):** `test/permissions-hardening.test.ts` MultiEdit cases,
  `test/agents.test.ts` Explore/Plan disallow-MultiEdit (~L405-417),
  `test/tools-parity.test.ts` (~L300-318).

## Acceptance criteria

- [ ] MultiEdit registered in the main session and grantable to subagents; absent from `DEGRADED_TOOLS`; present in `allKnownToolNames()` and `touchedFilePath()`.
- [ ] `tool.MultiEdit` registry tier is `full` with the honest note; `doc/supported-features.md` regenerated and in sync.
- [ ] `touchedFilePath("MultiEdit", …)` unit test passes; integration tests prove registration and (via a freshly-wired instance) nested-context injection for MultiEdit; registry drift/freshness tests green.
- [ ] typecheck and full test suite green.

## Depends on

t01

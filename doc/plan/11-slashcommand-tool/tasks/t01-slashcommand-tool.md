# t01: Real SlashCommand tool via shared skill-activation closure

## Goal

`SlashCommand` is a real, working tool (not a degraded no-op). A model call
`SlashCommand({ command: "/deploy staging 1.2.3" })` activates the `deploy`
skill with args `staging 1.2.3`, producing the same result the `Skill` tool
produces for `{ name: "deploy", arguments: "staging 1.2.3" }`. It honors skill
semantics identically (disable-model-invocation refusal, `context: fork`
dispatch, dedup) and is available to the main session and to subagents granted
it. The capability registry, generated matrix, and CHANGELOG reflect the real
tool at tier `partial`. typecheck + full suite green.

## Context & seams

All line numbers are current-state anchors in `src/index.ts`; treat them as
"find the closure near here," not literal addresses.

**The shared closure (the core refactor).** `createSkillTool({depth,
forSubagent})` lives at `src/index.ts:692-740`; the main instance is built at
`741-742`. Extract the post-resolution body of its `execute` (currently
`706-737` — the `disableModelInvocation` guard, the `contextFork` fork branch
via `forkDispatch`, the `skillDedupNote` path, and the `skillActivationMessage`
return) into a session-scope closure:

```
async function runSkillActivation(
  skill: ClaudeSkill,
  argsText: string,
  opts: { forSubagent: boolean; depth: number; invokedName: string },
): Promise<{ content: ...; details: ... }>   // returns the tool result, or throws
```

It calls the existing closures `activateSkill` (310), `forkDispatch` (397),
`skillDedupNote` (381) and the imported `skillActivationMessage` (32) exactly as
the current body does — no behavior change for the `Skill` tool. Then
`createSkillTool.execute` becomes: `findByName(project.skills, params.name)` →
(throw `Unknown skill: <name>` if absent) → `runSkillActivation(skill,
params.arguments ?? "", {forSubagent, depth, invokedName: params.name})`.

**Preserve the refusal-message name source (behavior-preservation trap).** The
current `disableModelInvocation` guard (index.ts:707) builds its message from
`params.name` — the caller-supplied name, which for a bare name that resolves to
a plugin-namespaced skill (`Skill({name:"review"})` → skill `my-plugin:review`)
differs from `skill.name`. Lifting the guard into the shared closure must NOT
silently switch it to `skill.name`, or the `Skill` tool's refusal wording changes
for that case (breaking "behavior-preserving"). Thread the caller's name in via
`opts.invokedName` and build the refusal message from it, so the `Skill` tool's
existing wording/tests stay unchanged. `SlashCommand` passes the parsed `<name>`
as `invokedName`.

**The new tool.** Define `createSlashCommandTool({depth, forSubagent})` as a
sibling session-scope closure right after `createSkillTool` (before line 741).
It must be a closure (needs `project`, `runSkillActivation`, `findByName` from
scope), mirroring `createSkillTool`. Its single parameter is a required
`command: Type.String` (Claude's SlashCommand takes one `/name args` string). Its
`description` is the model's whole contract, so it must: state the format
`/name [args]`; point at the same **"Available skills" listing** the `Skill`
tool's description cites as the source of valid names (so the model knows which
`/names` resolve rather than guessing); and note it is equivalent to the `Skill`
tool for `/name args` command strings (so a model handed both doesn't dither).
Keep it short. Its `execute`:
1. Parse `command` → `(name, argsText)` (see parse rules under Approach
   constraints). If the command is empty / whitespace-only / a bare `/` (no name
   token), **throw** a dedicated actionable message, e.g.
   `SlashCommand requires a command like "/name args".` (not `Unknown slash
   command: /`, which names nothing).
2. `findByName(project.skills, name)` → if absent, **throw**
   `Unknown slash command: /<name>`.
3. `runSkillActivation(skill, argsText, {forSubagent, depth, invokedName: name})`.

Because it delegates to the shared closure, it inherits the
`disableModelInvocation` refusal, fork dispatch, and dedup automatically. The
model-blocked error message is the shared closure's existing one; if the shared
closure emits the `Skill`-tool wording, that is acceptable — do NOT add a
separate `userInvocable` gate (see Approach constraints).

**Registration.**
- Main session: after line 742 (`claudeNamedTools.push(skillTool ...)`), add
  `const slashCommandTool = createSlashCommandTool({ depth: 0, forSubagent:
  false }); claudeNamedTools.push(slashCommandTool as Record<string,
  unknown>);`.
- Per-dispatch subagent: the Skill grant is `if (granted.includes("Skill"))` at
  `621-625` inside `customToolsFor` (`608-648`). Add an exact parallel block:
  `if (granted.includes("SlashCommand")) { tools.push(createSlashCommandTool({
  depth, forSubagent: true }) as Record<string, unknown>); }`.

**Known-tool list (MUST-FIX or subagents can never receive it).**
`allKnownToolNames()` at `581-606` is an explicit array plus
`...DEGRADED_TOOLS.map(...)` (line 604). Removing `SlashCommand` from
`DEGRADED_TOOLS` drops it out of this universe, so `gateTools` would filter it
away and `granted.includes("SlashCommand")` is always false. Add the literal
`"SlashCommand"` to the explicit array (next to `"Skill"` at line 594).

**Degrade-stub removal.** Remove the `SlashCommand` block from `DEGRADED_TOOLS`
in `src/runtime/tools/degrade-stubs.ts:84-87`. Optionally leave a one-line
breadcrumb comment mirroring the existing `// TaskOutput/TaskStop are REAL tools
now` at line 88. This stops the stub being instantiated in `buildCwdBoundTools`
(index.ts:482) for both surfaces — correct, the real tool replaces it.

**Registry retier (required for the drift guard).**
`src/registry/capability-registry.ts:75` declares `tool.SlashCommand` as
`degraded-noop`. `test/registry.test.ts` asserts two-way sync between
`degraded-noop` entries and `DEGRADED_TOOLS`, so this MUST change to `partial`
in the same commit. Match the existing `partial` note shape (e.g. `tool.TaskStop`,
`tool.TodoWrite`): a lead phrase, a `PARTIAL:` constraint clause, and a trailing
section ref `(§4.1, §4.8)`. (Do NOT lead with an em-dash — that is the
degraded-noop pattern.) Suggested note (adapt wording, keep the gap accurate):

> thin alias over the skill-activation path (mirrors the Skill tool): parses a
> leading /name (incl. plugin-namespaced /plugin:name) + trailing args from the
> command string and activates the resolved skill; an unknown or model-blocked
> command throws a model-visible error like the Skill tool. PARTIAL: covers all
> user-defined skills/commands but NOT the built-in commands Claude 2.1.x can
> also invoke via this path (/init, /review, /security-review) — PiCC ships no
> such built-ins; other built-ins (/clear, /compact, ...) are non-model-invocable
> in Claude too (§4.1, §4.8)

**Matrix regen.** `doc/supported-features.md` is generated — run `npm run
gen:capabilities`. Do NOT hand-edit it. The row, the `Tools (35)` count
(unchanged), and the Summary counts update automatically.

**CHANGELOG.** Add an entry under `## [Unreleased]` in `CHANGELOG.md`, e.g.
`### Added — SlashCommand tool (2026-07-14)`, stating the new `partial` tier and
that `doc/supported-features.md` was regenerated from the registry (mirror the
existing registry-truthfulness entry style, ~line 134).

## Writable surface

- `src/index.ts`
- `src/runtime/tools/degrade-stubs.ts`
- `src/registry/capability-registry.ts`
- `doc/supported-features.md` (regenerated, not hand-edited)
- `CHANGELOG.md`
- `test/integration-extension.test.ts`
- `test/registry.test.ts` (only the tier/sync expectations that must move)
- new/added test cases in the above test files; a new fake-sdk-based test file
  is acceptable if a fork/subagent-depth case doesn't fit an existing file
- `doc/plan/11-slashcommand-tool/log/t01.md` (execution log)

Everything else is read-only. Do NOT add PiCC-native built-in slash commands, do
NOT touch the user-typed slash-command transform (index.ts ~1012-1058), do NOT
add `SlashCommand` to `tool-map.ts` (it is a PiCC-registered Claude-named tool,
not a Pi built-in — same as `Skill`).

## Approach constraints

- **Gate on `disableModelInvocation` ONLY, never `userInvocable`.** This is the
  load-bearing parity decision. Claude's model-invocation path lets
  `user-invocable: false` skills through (they are model-only) and blocks only
  `disable-model-invocation`. The shared `runSkillActivation` (lifted from the
  Skill tool) already gets this right — do not add a `userInvocable` check from
  the user-typed transform. Fixture check: `/rust-helper` (userInvocable:false)
  must RUN via SlashCommand; `/secret-ritual` (disable-model-invocation) must be
  REFUSED.
- **Single command, no stacking.** Parse only the first `/name` token; the rest
  is the args string. Do NOT reuse the up-to-5 stacking loop from the user-typed
  transform — that is a prompt-transform behavior, not the tool's.
- **Parse rules for `command`:** trim; accept an optional leading slash (be
  tolerant — `/deploy x` and `deploy x` both resolve). Match the name with the
  same token shape the transform uses,
  `[A-Za-z0-9][\w-]*(?::[\w-]+)*`, so `/plugin:name` namespacing and
  `findByName`'s bare-name resolution behave identically. Empty / whitespace-only
  / bare `/` (no name token) → throw the dedicated
  `SlashCommand requires a command like "/name args".` message (never an
  unhandled crash, and not the nameless `Unknown slash command: /`). Whitespace
  between name and args uses `[ \t]` like the transform.
- Keep the refactor behavior-preserving for the `Skill` tool: its existing tests
  must stay green unchanged.

## Left open

- Exact prose of the tool `description` (constraints above fix its content;
  wording is open — keep it short).
- Whether to add a breadcrumb comment in `degrade-stubs.ts`.
- Exact CHANGELOG bullet wording.
- Whether the fork/subagent-depth case lives in an existing test file or a small
  new fake-sdk file.
- Whether to extract a tiny shared parse helper or inline the regex in the tool.

## Testing

Offline-integration is the primary layer (fakePi + `examples/full-surface`
fixture), in `test/integration-extension.test.ts`, mirroring the existing
`describe("skill activation")` block that fetches `pi.tools.get("Skill")` and
calls `.execute`. Cover:

- Happy path with args: `{ command: "/deploy staging 1.2.3" }` → body +
  substituted args; assert it equals the `Skill` tool's result for the
  equivalent `{name, arguments}`.
- Plugin-namespaced: `/plugin-skill` (and a `:`-form) resolves and substitutes
  `${CLAUDE_PLUGIN_ROOT}`.
- Model-only skill runs: `/rust-helper` (userInvocable:false) activates (locks
  in the gate decision).
- disable-model-invocation refusal: `/secret-ritual` → error matching
  `/user-only/`.
- Dedup: two identical `/redo x` calls → second returns the dedup note with
  `details.deduplicated === true`; bonus: Skill-tool-then-SlashCommand identical
  content also dedups (proves shared fingerprint set).
- Unknown command: `/no-such-skill foo` → throws, naming the command (not a
  crash, not a silent success).
- Parse edges: `""`, `"   "`, `"/"` → throw the dedicated "requires a command"
  message; the no-slash form `"deploy staging"` → activates per the tolerant
  parse rule. Assert throws with `.rejects.toThrow(...)` (mirroring the Skill
  tool's refusal test, `integration-extension.test.ts:212`) — the `Skill` tool
  registers as a raw object with no execute-level try/catch and surfaces refusals
  by rejecting, so do NOT assert on a returned `isError` body; `SlashCommand`
  mirrors this exactly.
- Registration: add `"SlashCommand"` to the registered-tool-surface list in
  `integration-extension.test.ts` (~44-59).
- `context: fork` dispatch + subagent-grant + depth: fake-sdk layer
  (`test/helpers/fake-sdk.ts`, as in `subagent-outcomes.test.ts`) — a
  `context: fork` skill invoked through SlashCommand returns the forked
  `finalMessage` / `details.forked`, and a subagent granted `SlashCommand` gets
  a working instance carrying dispatch depth. Do NOT push this to e2e.

Update, in the same change: `test/registry.test.ts` tier/sync expectations for
`SlashCommand` leaving `degraded-noop`/`DEGRADED_TOOLS` (and add it to any
"core tool surface as full/partial" list there at the `partial` tier). Regenerate
`doc/supported-features.md` BEFORE running `npm run test:unit` or the matrix
freshness test fails. `test/tools-parity.test.ts` is auto-consistent (loops over
`DEGRADED_TOOLS`) — no edit expected.

Cross-platform: the tokenizer is pure string work — use `[ \t]` not `\s`, matching
the transform. Pick a shell-free skill (`deploy`) for the args happy-path so it
runs identically on Windows + Linux; the fork/subagent test is process-free and
OS-agnostic.

Run: `npm run typecheck`, then `npm run gen:capabilities`, then `npm run
test:unit`, and `npm test` (full, incl. e2e) before reporting done.

## Acceptance criteria

- [ ] `SlashCommand({command})` activates the resolved user-invocable skill with
      args; result equals the `Skill` tool's for the equivalent input.
- [ ] `/plugin:name` resolves; `user-invocable:false` skill runs;
      `disable-model-invocation` skill is refused; repeat invocation dedups.
- [ ] Unknown / empty / bare-slash command returns a clean error result, never an
      unhandled crash.
- [ ] Tool is registered for the main session and grantable to subagents (in
      `allKnownToolNames`); a granted subagent can use it and forked skills carry
      dispatch depth.
- [ ] `SlashCommand` removed from `DEGRADED_TOOLS`; registry entry retiered to
      `partial` with an accurate note; `doc/supported-features.md` regenerated;
      CHANGELOG updated.
- [ ] The `Skill` tool's existing behavior/tests are unchanged by the refactor.
- [ ] typecheck and full test suite green.

## Depends on

–

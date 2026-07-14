# t01: Implementer & generalist agent definitions

## Goal

Two new project agents exist under `.claude/agents/` and load cleanly, each with a tool set that
**excludes** `Agent`/`Task` (no nested dispatch) and `Skill` (no skill re-entry):

- `implementer` — write-capable executor of a single task spec.
- `generalist` — read-only broad/adversarial reviewer.

After this task, dispatching either type yields an agent that cannot spawn a further subagent.

## Context & seams

- Agents are auto-discovered from `.claude/agents/*.md` (`loadAgents`, `src/claude/agents.ts`); **no
  `src` change is required**. Tool provisioning is `gateTools(agent.tools, agent.disallowedTools,
  allKnownToolNames())`, and nested dispatch is offered only when the granted set contains `Agent`
  or `Task` (`buildSubagentSystemPrompt` → `nestedDispatchAvailable`, `src/index.ts:553`). So an
  explicit `tools:` allowlist that omits `Agent`/`Task` reliably removes dispatch.
- Known tool names (the only ones worth listing; others are dropped by `gateTools`): `Read, Write,
  Edit, Bash, Grep, Glob, WebFetch, WebSearch, Agent, Task, SendMessage, Skill, EnterWorktree,
  ExitWorktree, TaskCreate/Update/List/Get, TodoWrite, TaskOutput, TaskStop`. PiCC has **no**
  `MultiEdit`/`NotebookEdit`.
- **Exact contracts consumed by t02** (names and tool lists must match):
  - `.claude/agents/implementer.md`: `name: implementer`, `tools: Read, Grep, Glob, Bash, Edit, Write`
  - `.claude/agents/generalist.md`: `name: generalist`, `tools: Read, Grep, Glob, Bash, WebSearch, WebFetch`
- Frontmatter shape mirrors the existing six specialists (see `.claude/agents/coder.md`): YAML
  frontmatter with `name`, `description`, `tools`, then a markdown body that is the system prompt.
- Catalog note: `isReadOnlyAgent` only marks an agent "(read-only)" when its `tools` allowlist
  contains none of `write`/`edit`/`bash`. Because `generalist` (like every existing specialist)
  keeps `Bash`, it will not carry that marker — consistent with the current roster. "Read-only" is
  therefore enforced by prompt+omission-of-write-tools, exactly as for `coder`/`security`/etc.

## Writable surface

- `.claude/agents/implementer.md` (create)
- `.claude/agents/generalist.md` (create)
- `test/implementer-generalist-agents.test.ts` (create — see Testing; final layer/placement is a
  tester call in review)
- `doc/plan/05-implementer-agent/log/t01.md`

## Approach constraints

- Use an explicit `tools:` allowlist (not `disallowedTools`) for least privilege — the agents get
  ONLY the listed tools, so no `Agent`/`Task`/`Skill`/worktree/task tools leak in by inheritance.
- The `implementer` description and body must be framed around *building the one task*, and must
  NOT invite it to review, delegate, or fan out. State plainly it cannot dispatch subagents and does
  all work itself.
- The `generalist` description/body must frame two modes (broad investigate / adversarial
  whole-corpus review) and read-only conduct.
- Neither agent commits or pushes (coordinator owns commits) — state it in the body, mirroring the
  standing rules the skill already relays.

## Left open

- Exact wording of each agent's body/system prompt.
- Whether `implementer` should also carry `WebFetch`/`WebSearch` (default: no — it works from the
  self-contained task spec; add only if review argues a real need).

## Testing

Add a unit test (`test/implementer-generalist-agents.test.ts`) that locks the no-dispatch invariant
on the **real shipped files** (not fixtures — a fixture copy could stay green while the real file
regains `Agent`). Precise, verified API shapes (reviewers checked these against source):

- **Resolve the agents dir from the test file, not cwd.** Use
  `path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", ".claude", "agents")` (idiom:
  `test/helpers/fixture.ts`). `process.cwd()`/hardcoded paths are unsafe — sibling tests `process.chdir`.
- Load via `loadAgents([{ dir, scope: "project" }])`.
- **Guard against a vacuous pass BEFORE any tool assertion:** assert `diagnostics` is empty and that
  both `implementer` and `generalist` were found, each with its exact `tools` list (t01 contracts). A
  bad-frontmatter load drops the agent silently — the test must fail loudly, not skip.
- Compute the gated set via a **`PermissionEngine` instance** — `gateTools` is a method, NOT a free
  function: `new PermissionEngine(<empty rules>, { cwd })` then
  `engine.gateTools(agent.tools, agent.disallowedTools, known)` (template: `test/permissions.test.ts`
  ~line 424). `allKnownToolNames()` is **not exported** — inline an equivalent `known` array that
  includes at least `Agent`, `Task`, `Skill`, `Edit`, `Write`, `Read`, `Grep`, `Glob`, `Bash`.
- Assert for BOTH agents: gated set contains none of `Agent`, `Task`, `Skill`. For `implementer`:
  contains `Edit` and `Write`. For `generalist`: contains neither `Edit` nor `Write`.
- Cross-platform: pure Node/vitest, no shell; `import.meta.url` + `path.resolve` normalize Windows
  separators/drive letters. (`toStringList` trims tokens, so a CRLF checkout can't break the list.)
- `npm run typecheck` and full `npm test` green (no new failures vs. baseline: 984 passed / 16 skipped).

## Acceptance criteria
- [ ] `implementer` and `generalist` load from `.claude/agents/` with the exact tool lists above (no load diagnostics).
- [ ] Neither agent's gated toolset includes `Agent`, `Task`, or `Skill`.
- [ ] Regression test asserts the no-dispatch invariant for both agents, and fails loudly if either agent is missing/unloadable.
- [ ] typecheck and full test suite green.

## Depends on
–

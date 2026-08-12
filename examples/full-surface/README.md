# full-surface — PiCC conformance fixture

A purpose-built Claude Code project exercising the **entire supported feature surface**,
including fields and paths a typical project never touches. Integration tests copy this
directory into a temp git repo and drive the harness against it.

Coverage map (each canary string is asserted by tests):

| Feature | Where | Canary |
|---|---|---|
| Root CLAUDE.md | `CLAUDE.md` | `FS-ROOT-CLAUDE-MD` |
| `@import` 2 hops | `docs/imported.md` → `docs/level2.md` | `FS-IMPORT-HOP-1/2` |
| Import immunity (email, code span, fence) | `docs/imported.md` | absence |
| HTML comment stripping | `CLAUDE.md` | `FS-STRIPPED-COMMENT` absent |
| CLAUDE.local.md | `CLAUDE.local.md` | `FS-CLAUDE-LOCAL-MD` |
| Nested CLAUDE.md on file access | `src/CLAUDE.md` | `FS-NESTED-SRC-CLAUDE-MD` |
| Unconditional + path-scoped + nested rules | `.claude/rules/` | `FS-RULE-*` |
| context:fork skill | `skills/fork-research` | `FS-SKILL-FORK-BODY` |
| Positional + named args | `skills/deploy` | `FS-SKILL-ARGS-BODY` |
| Shell injection (bash inline + fenced, ${CLAUDE_*} vars) | `skills/repo-info` | `FS-SKILL-SHELL-BODY` |
| Shell injection (powershell) | `skills/ps-info` | `FS-PS-INJECTED` |
| Path-scoped, non-invocable skill | `skills/rust-helper` | `FS-SKILL-PATHS-BODY` |
| disable-model-invocation + unknown frontmatter | `skills/secret-ritual` | `FS-SKILL-USERONLY-BODY` |
| Legacy command + args | `.claude/commands/ship.md` | `FS-LEGACY-SHIP` |
| Nested subagents (depth 2 — **explicit opt-in** via `subagents.maxDepth: 2` in `.claude/settings.json`; nesting is off by default/main-session-only) | `agents/planner.md` → researcher | — |
| Background dispatch + collection-aware `TaskOutput` delivery (terminal collection suppresses a redundant notice; running poll does not) | `agents/async-researcher.md`, `.claude/commands/bg-research.md` | `FS-BG-TASKOUTPUT` |
| Read-only gating / web tools / locked YAML | `agents/reviewer.md`, `researcher.md` | — |
| isolation: worktree | `agents/isolated-worker.md` | — |
| Agent MCP declaration syntax and inert topology | `agents/future-agent.md` | `fixture-session` reference + `fixture-inline` definition |
| Permissions: allow globs, deny, ask (`/doctor` report) | `.claude/settings.json` | — |
| Hook events incl. unknown event + degraded handler type | `.claude/settings.json` | `FS-*-HOOK*` |
| stdin JSON + additionalContext hook | `tools/write-guard.sh` | `FS-WRITE-GUARD` |
| Worktree seeding | `.worktreeinclude`, WorktreeCreate hook | `.worktree-seeded` |
| cwd-swap detectability | `tools/preflight.sh` | `mode=worktree` |
| Unknown settings keys | `futureUnknownSetting`, `outputStyle` | compat report |
| MCP pending-approval gate (unapproved project server) | `.mcp.json` (`example-server`) | compat report + pending notice |
| Installed-plugin source copied into a hermetic cache/state layout | `.claude-plugin/` → test-created installed root | `FS-PLUGIN-SKILL-BODY` |
| Notebook read/edit workflow | `analysis.ipynb`, `test/e2e-notebook.test.ts` | real and fallback cell IDs |

`future-agent` declares one shared reference and one inline stdio server in the documented list
shape. Both names are intentionally inert in this fixture: `fixture-session` has no configured
session server and project-inline `fixture-inline` is unapproved. The fixture proves
loading, static reporting, and topology only; focused runtime tests own connection reuse, dispatch
isolation, and cleanup behavior.

The background command documents the directional settlement guidance (focused runtime tests prove the
behavior): an eligible uncollected current task gets one bounded next-turn notice, but a terminal
`TaskOutput` return is already delivery and suppresses that redundant notice. Polling while running
preserves notice eligibility.

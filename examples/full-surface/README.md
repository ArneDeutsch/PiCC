# full-surface — PiClauDex conformance fixture

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
| Nested subagents (depth 2) | `agents/planner.md` → researcher | — |
| Read-only gating / web tools / locked YAML | `agents/reviewer.md`, `researcher.md` | — |
| isolation: worktree | `agents/isolated-worker.md` | — |
| Deferred agent fields degrade | `agents/future-agent.md` | — |
| Permissions: allow globs, deny, ask (compat notice) | `.claude/settings.json` | — |
| Hook events incl. unknown event + degraded handler type | `.claude/settings.json` | `FS-*-HOOK*` |
| stdin JSON + additionalContext hook | `tools/write-guard.sh` | `FS-WRITE-GUARD` |
| Worktree seeding | `.worktreeinclude`, WorktreeCreate hook | `.worktree-seeded` |
| cwd-swap detectability | `tools/preflight.sh` | `mode=worktree` |
| Unknown settings keys | `futureUnknownSetting`, `outputStyle` | compat report |
| `.mcp.json` degradation | `.mcp.json` | compat report |
| Project-bundled plugin | `.claude-plugin/` | `FS-PLUGIN-SKILL-BODY` |

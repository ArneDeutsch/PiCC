# hello-claude — minimal PiClauDex example project

A tiny project authored **for Claude Code** (CLAUDE.md, `.claude/` skills/agents/rules/settings)
that PiClauDex runs unchanged on GPT/Codex models.

What it exercises:

| Artifact | File | Behavior to observe |
|---|---|---|
| CLAUDE.md + `@import` | `CLAUDE.md` → `AGENTS.md` | Both canary words reach the model context |
| Skill + slash command | `.claude/skills/greet/` | `/greet Ada` substitutes `$1`/`$ARGUMENTS`; body lazy-loads |
| Legacy command | `.claude/commands/status.md` | `/status` works |
| Subagent | `.claude/agents/reviewer.md` | `reviewer` is dispatchable, read-only (tools gated) |
| Rules | `.claude/rules/style.md` | Loaded at session start |
| Permissions | `.claude/settings.json` | `Read(.env)` and `rm -rf` are hard-denied |
| Hooks | `.claude/settings.json` | Warn-only PreToolUse guard injects context on Write/Edit |

Try it (from this directory, with PiClauDex installed — see the user guide):

```bash
piclaudex            # or: pi -e <path-to-piclaudex>/src/index.ts
> /greet Ada
> ask the reviewer agent to review src/hello.js
```

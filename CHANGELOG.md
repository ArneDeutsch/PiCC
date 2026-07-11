# Changelog

All notable changes to PiClauDex are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/), and the project aims to follow
[Semantic Versioning](https://semver.org/).

## [0.1.0] — 2026-07-11

First complete version. Runs real Claude Code projects unchanged on GPT/Codex models via a
personal ChatGPT/Codex subscription, built as an extension bundle on
[Pi](https://github.com/earendil-works/pi) (pinned to v0.80.6).

### Added — fully-functional subsystems

- **Skills** — full `SKILL.md` frontmatter, progressive disclosure (bodies load only on
  activation), `$ARGUMENTS`/positional/named argument substitution, `${CLAUDE_*}` variables,
  `` !`cmd` `` shell injection under bash and PowerShell, `context: fork`, and legacy
  `.claude/commands/*.md`.
- **Rules** — `.claude/rules/**` with unconditional and `paths:`-scoped injection.
- **Agents & subagent dispatch** — `.claude/agents/*.md`, description-driven routing, parallel
  fan-out with verbatim final-message return, per-agent `tools:` capability gating, nested
  dispatch with a configurable depth cap, and `isolation: worktree`.
- **Worktrees** — `EnterWorktree`/`ExitWorktree` with a real session-cwd swap, `.worktreeinclude`
  seeding, Windows-tolerant removal + orphan reaping, and concurrent parallel sessions.
- **Hooks** — 13 events (`PreToolUse` … `WorktreeRemove`) with the full stdin-JSON/stdout-decision
  contract, `matcher` + `if:` conditions, plus plugin- and skill-scoped hooks.
- **CLAUDE.md hierarchy** — root→cwd concatenation, nested on-demand injection, recursive
  `@import` (the AGENTS.md bridge), HTML-comment stripping, `claudeMdExcludes`.
- **Settings & permissions** — full precedence/merge, honored toggles, `deny` rules as a hard
  block with the complete matcher grammar; `allow`/`ask`/modes parsed and reported.
- **Compatibility report** — a living capability registry drives a consolidated startup notice and
  `/doctor`, so documentation can't drift from behavior.
- **Compaction preservation** — project instructions, rules, and active skills survive compaction.
- **Installed-plugin content** and project-bundled `.claude-plugin/`. Plugins load only when
  **explicitly enabled** (settings `enabledPlugins`, matched by `name@marketplace`) and never when
  blocklisted — a cloned marketplace is a catalog, not installed content, so its plugins stay
  dormant until you enable them (matching Claude Code). A one-line info notice reports how many
  plugins are available but disabled.
- **Control surface** — `/skills`, `/agents`, `/doctor`, `/compat`, `/quota`; project-external
  model/effort/steering config; quota introspection.

### Windows hardening

- Pin Pi's `bash` tool to real Git Bash, never the System32 WSL stub
  (`WSL_E_DEFAULT_DISTRO_NOT_FOUND`).
- Force UTF-8 stdio for spawned subprocesses (fixes cp1252 `UnicodeEncodeError` when tools print
  Unicode such as `→`).
- Lenient-YAML frontmatter fallback so agents/skills whose descriptions contain `": "` (valid to
  Claude Code, invalid to strict YAML) still load.
- `core.longpaths`, reparse-point stripping, and best-effort worktree removal.

### Distribution

- Ships as TypeScript source loaded by Pi via jiti (no build step). Installable by
  `git clone && npm install && npm link`, or as an npm tarball / package (`piclaudex` bin).
- GitHub Actions CI across Windows + Linux on Node 20 and 22, plus a tag-triggered release that
  packs the tarball and (optionally) publishes to npm.

### Tested

- 360+ tests: unit tests per subsystem, offline integration driving the whole extension through a
  fake Pi API, and end-to-end tests that drive the **real Pi CLI against a mock OpenAI-compatible
  server** — no real model required. Live-validated on a real ChatGPT/Codex subscription and
  against the DemonMatrix reference project.

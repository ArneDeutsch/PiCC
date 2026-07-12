# Changelog

All notable changes to PiCC are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/), and the project aims to follow
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added — commit and CI gates (2026-07-12)

- **Pre-commit hook** (`.githooks/pre-commit`): runs `npm run test:unit` before every commit;
  wired automatically by the `prepare` script on `npm install`/`npm ci`, manually via
  `git config core.hooksPath .githooks` after an `--ignore-scripts` install.
- The `implement-feature` skill now expects the hook (never `--no-verify`) and, when the
  `gh` CLI is available, verifies the pushed branch's CI run is green before hand-off.

### Changed — first CI run on GitHub (2026-07-12)

- **Node floor raised to ≥ 22.19** (`engines`, CI matrix now 22/24, docs): Pi's bundled
  undici 8.x requires `worker_threads.markAsUncloneable`, which does not exist on Node 20 —
  the harness (and the e2e-driven Pi CLI) crashes at import there.
- **Fixed Linux-only test failures**: `rules.test.ts` used a hardcoded `F:\` Windows root
  (invalid absolute path on POSIX); the `full-surface` example hook scripts (`write-guard.sh`,
  `preflight.sh`) were committed without the executable bit, so hooks silently produced no
  output on Linux.

Deep completeness audit against Claude Code 2.1.x (official docs, changelog, and the
`anthropics/claude-code` issue tracker) — see `doc/review/2026-07-12-completeness-audit.md`
for the full gap analysis. All P1/P2 gaps fixed with tests.

### Changed — spec-parity corrections (behavior changes)

- **Argument substitution**: `$N` is now 0-based and greedy multi-digit (`$0` = first argument,
  `$100` = index 100), matching `$ARGUMENTS[N]`; the invented `$$` escape is replaced by
  Claude's `\$` backslash escape.
- **Bash permission rules**: `Bash(cmd *)` / `Bash(cmd:*)` now match the bare command
  (space-before-`*` is a word boundary meaning "space or end of string").
- **Hook matchers**: plain names match exactly (with `|`/`,` alternation); regex matchers are
  unanchored, per Claude semantics. Matching hooks now run in **parallel** with identical-command
  dedup; the Stop-hook loop cap is 8.
- **CLAUDE.md discovery**: ancestor directories are walked to the filesystem root (not just the
  git root); `.claude/CLAUDE.local.md` no longer auto-loads; managed-policy CLAUDE.md (file or
  inline `claudeMd` settings key) loads first and is exclusion-proof.
- **Skill listing**: per-entry description cap is 1536 chars with tiered degradation (drop
  `when:` → truncate → names-only) — skills are never silently omitted; `SLASH_COMMAND_TOOL_CHAR_BUDGET`
  honored. Compaction re-injects active skills under Claude's 5k/25k-token budgets.
- **Subagents**: default nesting depth is now 5; user/project rules order corrected.

### Added

- **Built-in agent types** `general-purpose`, `Explore`, `Plan` (project agents override;
  `CLAUDE_CODE_DISABLE_EXPLORE_PLAN_AGENTS` honored); omitted `subagent_type` defaults to
  general-purpose; `CLAUDE_CODE_SUBAGENT_MODEL` model-resolution order.
- **Background subagents**: `run_in_background: true` runs dispatches concurrently; **TaskOutput**
  and **TaskStop** are now real tools (`CLAUDE_CODE_DISABLE_BACKGROUND_TASKS` honored).
- **Auto memory**: project `MEMORY.md` (first 200 lines / 25 KB) loads at session start with
  write-back conventions; `autoMemoryEnabled`, `autoMemoryDirectory`,
  `CLAUDE_CODE_DISABLE_AUTO_MEMORY`. Agent `memory: user|project|local` frontmatter now injects
  per-agent memory.
- **Agent-scoped hooks** (`hooks:` in agent frontmatter) dispatch while the subagent runs.
- **Hook contract depth**: `permission_mode`, `transcript_path`, `tool_use_id`,
  `last_assistant_message`, structured `tool_response` stdin fields; `systemMessage`,
  `suppressOutput`, `async: true` handlers; per-event timeouts (30 s UserPromptSubmit);
  `${CLAUDE_PLUGIN_DATA}` expansion.
- **Stacked slash invocations** (`/a /b task…`, up to 5), skill re-invocation dedup notes,
  recursive `.claude/commands/**` discovery with `sub:name` collision qualification,
  `allowed-tools` variable/argument substitution, `fallback`/`license`/`display-name` keys.
- **Windows permission-path normalization** (`C:\…` ↔ `//c/**`, case-insensitive), deny-direction
  env-prefix stripping (`FOO=1 rm …` matches `Bash(rm *)`), unanchored-MCP-allow-glob validation.
- **Failed `` !`cmd` `` injections** now preserve the literal placeholder text (Claude parity).

### Fixed — multi-angle review hardening (same day)

Four independent review passes (adversarial, scenario walkthrough, spec-fidelity, docs) over the
audit change set; 18 confirmed findings fixed — highlights (full table in
`doc/review/2026-07-12-completeness-audit.md`):

- Active-skill `disallowed-tools` now match with deny polarity — chained (`a && rm …`) and
  env-prefixed commands no longer evade them.
- `async: true` hook handlers survive the settings/agent normalizers (they ran blocking before).
- UNC path rules (`Read(//server/share/**)`) match `\\server\share\…` inputs; deny-direction
  realpath skipped for UNC (multi-second stall fix).
- `once:` hooks deduplicated across merged settings scopes fire exactly once.
- Auto memory reaches subagent prompts (except Explore/Plan); the resident active-skills prompt
  section and structured `tool_response` hook payloads are budget-capped.
- Live-Pi e2e suite extended with built-in-agent, background-task, auto-memory, subagent×worktree
  and stacked-skill scenarios (real Pi CLI + scripted model); bash-dependent e2e tests no longer
  silently skip on per-user Git installs. Verified live against a real OpenAI-subscription model:
  built-in Explore dispatch and the full worktree lifecycle work end-to-end.

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
  `git clone && npm install && npm link`, or as an npm tarball / package (`picc` bin).
- GitHub Actions CI across Windows + Linux on Node 20 and 22, plus a tag-triggered release that
  packs the tarball and (optionally) publishes to npm.

### Tested

- 360+ tests: unit tests per subsystem, offline integration driving the whole extension through a
  fake Pi API, and end-to-end tests that drive the **real Pi CLI against a mock OpenAI-compatible
  server** — no real model required. Live-validated on a real ChatGPT/Codex subscription and
  against the DemonMatrix reference project.

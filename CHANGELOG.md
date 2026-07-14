# Changelog

All notable changes to PiCC are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/), and the project aims to follow
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Fixed — defensive background-task error storage (2026-07-14)

- Resolved failed and aborted background dispatches now retain only bounded, single-line error text
  at the task-registry boundary. Whitespace and Unicode `Cc` control-character runs are normalized and
  oversized errors are capped, preventing future dispatch callers from bypassing the existing
  defense-in-depth handling on user-visible and model-facing failure paths.

### Added — GitHub ticket integration for implement-feature (2026-07-14)

- **`implement-feature` can now be invoked with a GitHub issue reference (`#5`, `5`, or an issue URL)
  and wire the whole cycle to that ticket.** With a ref present the skill scopes the Phase 1 direction
  conversation from the issue (title, body, labels, and comments read via `gh`) and, at hand-off, opens
  a ready-for-review pull request linked to the ticket (`Closes #N` when the work fully delivers the
  ticket, a bare `#N` when it only partly does) and posts **one** comment on the issue explaining what
  was built and how the application's behaviour changes. Nothing is posted to the ticket before hand-off.
  The two hand-off artifacts are written for their audiences: the PR body is a *"Start your review
  here"* guide to verifying the change in the running app, while the issue comment speaks to the
  ticket's readers. At close — on either the ticket or the ticketless path — the skill also **offers to
  file surfaced out-of-scope findings** (unfixed bugs, improvements) as GitHub issues, per-item and only
  with explicit approval. The change stays **essentially additive**: invoked with no argument the skill
  does no ticket reads and no auto-PR, and the issue-filing offer is opt-in and appears only when GitHub
  is reachable. Failure handling is **honest** — a missing or unauthenticated `gh`, an unreadable issue,
  a wrong-repo URL, or a missing `origin` remote stops the ticket path with clear guidance instead of
  silently dropping the ticket, and a **closed** issue prompts a warning before work starts; a write
  rejected after successful reads degrades to a manual hand-off with paste-ready artifacts; and all
  writes are idempotent on resume (no duplicate comment, PR, or issue). Skill-prose only — no `src/`
  change.

### Changed — consistent background-task identity (2026-07-14)

- **Background lifecycle messages now use one compact identity vocabulary.** A task id identifies
  one background run; the stable agent id correlates the agent across resume, when a new task id is
  created. `TaskStop` results and pushed settlement notices use their background task record's stored
  display type: a fresh dispatch normally stores the requested/display label, while a resumed task
  stores the clean resolved registry name. A `SendMessage` resume acknowledgment also uses that
  resolved name. All identify `Task(task-N) · Agent(<type>) · agent-<id>`. These model-visible wording
  changes are PiCC-defined, not verified as exact Claude Code wording; broader canonical-type
  plumbing remains deferred. Tool schemas, lifecycle and stop behavior, settlement delivery,
  structured results, output framing, and limits are unchanged.

### Changed — implement-feature workflow agents (2026-07-14)

- **The `implement-feature` skill no longer routes work to `general-purpose`.** Two dedicated,
  **non-dispatching** project agents now do the non-specialist work: `implementer` (write access —
  builds task specs and applies fixes) and `generalist` (read-only — adversarial whole-plan/whole-diff
  review and broad cross-surface investigation). Neither carries the `Agent`/`Task`/`Skill` tool, so
  the coordinator is the sole orchestrator: a dispatched agent can no longer spontaneously spawn its
  own review roster (previously observed when `general-purpose` implementers fanned out a level down).
  A regression test locks the no-dispatch invariant on the shipped agent files. No harness change —
  nested subagents and their depth cap remain Claude-faithful; this only changes which agents the
  skill hands work to.

### Added — background-task observability (2026-07-13)

- **`TaskOutput` streams like a foreground agent.** A `TaskOutput` call awaiting a still-running
  background dispatch now renders a live view like a running foreground subagent — a self-identifying
  header, a rolling tail of recent activity, and a current-activity line that updates as the subagent
  works — instead of a bare unlabelled chip. When the task settles, the *same* call resolves to a
  finished view: an outcome badge (completed / failed / aborted), the agent's transcript path, and
  per-subagent usage — matching a completed foreground dispatch. A poll (`wait: false`) shows the
  task's current status and last activity inside that same identifying frame.
- **Every background surface names its agent.** The "background task started" message, the awaiting/
  live `TaskOutput` render, the poll, and the settled result all name the **dispatched agent** — its
  type and its stable `agent-<id>` — so a `task-N` id is never anonymous and traces to its agent and
  on-disk transcript. The `agent-<id>` identity is shown even for **non-resumable one-shot builtins**;
  the "resumable via `SendMessage`" invite still appears only when the task is actually resumable.
- **Display-only — the model contract is preserved.** This is an observability change: the completed
  verbatim result text `TaskOutput` returns to the model is **byte-identical**, and the settlement-push
  mechanism is untouched. Only PiCC-authored running/poll/failed/stopped metadata gained the identity.
  The new rendering honors the same width-clamp and sanitize guarantees as foreground rendering.

### Fixed — subagent render crash on over-wide lines (2026-07-13)

- **A running or finished `Agent(...)` block no longer crashes the whole app.** The subagent
  renderer could emit a line wider than the terminal — a long live-activity line, a long
  `transcript:` session path in the footer, or any CJK/wide/tab content — which tripped pi-tui's
  render invariant and exited the process with an uncaughtException. Every rendered line is now
  clamped to the terminal width using pi-tui's own column measure (`@earendil-works/pi-tui`, now a
  direct dependency), so wrapping/truncation agrees exactly with the check pi-tui enforces.
- **The footer stays readable.** A transcript path too wide to fit degrades to its basename
  (`transcript: …/agent-….jsonl`) instead of wrapping into unreadable fragments; the full path is
  still shown when it fits and always reaches the model verbatim.
- **The agent name is sanitized on the display path.** A model-supplied `subagent_type` or a
  project agent file's `name:` frontmatter can no longer replay terminal-control sequences into the
  parent terminal via the title/outcome badge.

### Fixed — subagent lifecycle: loud failures (2026-07-13)

- **Subagent dispatches no longer return an empty success on failure.** A dispatch that ends on a
  terminal API error is now reported as a **loud failure naming the cause** — in the foreground
  tool result, and in the background task's status and its `TaskOutput` retrieval. This closes the
  regression from the **2026-07-12 dogfooding incident**, where a drained usage limit made every
  subagent dispatch fail instantly, PiCC returned those failures as empty successes, and the
  coordinator — unable to tell "reviewer found nothing" from "reviewer never ran" — committed
  under-reviewed work and silently absorbed the implementation into its own context. Retry
  behavior is unchanged (Pi's own; no extra recovery logic). Matches Claude Code's 2.1.199/2.1.200
  failure semantics.
- **Partial output is preserved.** A subagent that produced output before dying (or that hit its
  turn cap) delivers that output inside an explicit `[subagent cut off]` frame rather than dropping
  it; a truncation also emits a warning diagnostic.
- **Deliberate stops are distinct from failures.** A run stopped on purpose (Esc / `TaskStop`)
  reports as **aborted**, not failed; Esc now actually cancels a running foreground dispatch.

### Added — subagent observability, channel & usage (2026-07-13)

- **On-disk transcripts.** Every dispatch leaves a JSONL transcript beside the main session's, at
  `<mainSessionFileBase>.subagents/<stamp>_<agentId>.jsonl`, discoverable from the session and
  readable during and after the run.
- **Stable agent IDs + live progress.** Each resumable dispatch gets a stable `agent-<12 hex>` id
  surfaced to the model in text; the UI shows the agent type + dispatch description (not a bare
  "Agent" box), a bounded rolling tail of recent activity, and silent API-retry waits.
- **`SendMessage` channel.** The coordinator can resume a finished subagent by its agent id (it
  continues in the background with full prior context) or steer a running background one (Claude
  Code 2.1.x semantics). Honest limits: no cross-restart resume (the registry is process-lifetime),
  steering reaches only background dispatches, idle-parent delivery is next-turn, and
  `context: fork`/override dispatches are non-resumable.
- **Background settlement push.** When a background dispatch settles (success or failure), the
  coordinator is notified at its next turn without calling `TaskOutput` (a bounded, untrusted-framed
  notice). `background: true` agent frontmatter (Claude 2.1.198) is honored, routing through the
  same background lifecycle.
- **Per-subagent usage accounting.** Token/cost usage is recorded with each dispatch result, in the
  transcript, and in a new **`/usage`** control command (per-subagent breakdown + a subagents
  total). `/usage` is **subagent-scoped only** — a PiCC-additive surface, not Claude Code's
  whole-session `/usage`/`/cost` (the Pi extension API exposes no parent-session cost).

### Changed — registry truthfulness (2026-07-13)

- Capability registry updated to match shipped behavior: `tool.Agent`/`tool.Task` downgraded to
  **partial** (PiCC defaults dispatches to the foreground; Claude 2.1.198 runs subagents
  background-by-default, so an implicit-concurrency fan-out runs serially); **new** `tool.SendMessage`
  (partial) and `agent.frontmatter.background` (full) entries; `feature.background-agents` now
  documents settlement push and the default-foreground gap; `tool.TaskOutput`/`tool.TaskStop`,
  `hook.event.SubagentStart`/`SubagentStop` (agent_id + agent_type; `transcript_path` stays MAIN),
  and `hook.event.Notification` (settlement fires no `agent_completed`) notes corrected;
  `setting.cleanupPeriodDays` downgraded to **partial** (worktrees only — no subagent-transcript
  reaper). `doc/supported-features.md` regenerated from the registry.

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

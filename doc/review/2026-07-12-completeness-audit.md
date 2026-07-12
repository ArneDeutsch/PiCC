# Completeness audit — PiCC vs Claude Code (2026-07-12)

Deep audit comparing every supported capability against Claude Code's actual behavior, researched
from the official docs (code.claude.com/docs), the changelog, and the `anthropics/claude-code`
issue tracker (closed-issue behavioral facts). Nine research passes: three implementation
inventories of PiCC (loaders, hooks/permissions, runtime) and six spec sweeps (memory/settings,
skills/commands, hooks, subagents, permissions, GitHub issues).

Legend: **P1** = wrong behavior a real Claude project would hit; **P2** = missing depth that
degrades fidelity; **P3** = nice-to-have / superset already acceptable. Status is filled in as
gaps are fixed.

## A. Skills & slash commands

| # | Gap | Claude Code behavior (source) | PiCC before | Pri | Status |
|---|-----|-------------------------------|-------------|-----|--------|
| A1 | `$N` positional substitution | `$N` ≡ `$ARGUMENTS[N]`, 0-based (`$0` = first arg), greedy multi-digit (`$100` is one token), missing index → empty string (docs skills.md; issue #76757) | `$1`..`$9` only, 1-based, single digit | P1 | fixed |
| A2 | Literal-`$` escape | `\$` escapes `$` before digit/ARGUMENTS/arg-name (v2.1.163); `\\$1` leaves both backslashes and still expands; `$$` has no special meaning | `$$` → `$` invented; no `\$` | P1 | fixed |
| A3 | Substitution in `allowed-tools` | `$ARGUMENTS` and `${CLAUDE_PROJECT_DIR}`/`${CLAUDE_PLUGIN_ROOT}` are substituted in `allowed-tools` frontmatter (docs; issue #67652) | body-only | P2 | fixed |
| A4 | Skill listing budgets | Per-entry cap 1,536 chars (`skillListingMaxDescChars`); listing budget = contextWindow × 4 chars × `skillListingBudgetFraction` (default 0.01, ≈8k chars); tiered degradation: drop low-priority descriptions → truncate → names-only; `SLASH_COMMAND_TOOL_CHAR_BUDGET` env override (issues #64606 et al.) | per-entry 200 chars; hard cutoff with "+N more" | P2 | fixed |
| A5 | `` !`cmd` `` failure handling | On failure/timeout the placeholder is left as literal text; output is single-pass, never re-scanned | replaced with `[command failed …]` note | P2 | fixed |
| A6 | Legacy commands in subdirectories | commands dirs are discovered; nested-name qualification exists for skills (`<dir>:<name>`, v2.1.203) | top-level `.md` only, subdirs ignored | P2 | fixed (recursive, `sub:name` qualified) |
| A7 | Stacked skill invocations | `/skill-a /skill-b do XYZ` loads up to 5 leading skills (v2.1.199) | only the first token parsed as skill | P2 | fixed |
| A8 | Re-invocation dedup | Re-invoking a skill with identical rendered content adds a short note instead of a full copy (v2.1.202) | full body re-appended every time | P3 | fixed |
| A9 | Compaction carryover budget | Most recent skills carried with first ~5,000 tokens each, 25,000 combined; older dropped | all active skills re-injected in full | P2 | fixed (char-budgeted re-injection) |
| A10 | Frontmatter keys `license`, `display-name`, `default-enabled`, `fallback` | Parsed (v2.1.186); malformed YAML loads body with empty metadata rather than dropping skill | unknown-key warnings; lenient parser already close | P3 | fixed (keys known) |
| A11 | `@path` in slash-command arguments attaches files (issue #52618) | resolved/attached | not handled | P3 | deferred (documented) |

## B. CLAUDE.md / memory

| # | Gap | Claude Code behavior | PiCC before | Pri | Status |
|---|-----|----------------------|-------------|-----|--------|
| B1 | Ancestor traversal above repo root | Walks from cwd up to the **filesystem root**, loading `CLAUDE.md` + `CLAUDE.local.md` at each level (memory.md; issues #26944/#20880) | stops at git root | P1 | fixed |
| B2 | `.claude/CLAUDE.local.md` | does **not** auto-load (issue #54425); `CLAUDE.local.md` loads next to `CLAUDE.md` in cwd-ancestor dirs but not in `.claude/` and not lazily in subtrees (issue #22652) | loaded a sibling `CLAUDE.local.md` for *every* candidate incl. `.claude/` | P2 | fixed |
| B3 | Managed-policy CLAUDE.md | Loaded from the managed dir (e.g. `/etc/claude-code/CLAUDE.md`, `C:\ProgramData\ClaudeCode\CLAUDE.md` for PiCC's managed root); cannot be excluded via `claudeMdExcludes`; managed settings `claudeMd` key injects inline content | not loaded | P2 | fixed |
| B4 | Auto memory (read side) | `MEMORY.md` under the per-project memory dir loads at session start — first 200 lines or 25 KB; `autoMemoryEnabled` (default true), `autoMemoryDirectory` setting, `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` | `setting.memory` degraded-noop | P2 | fixed (read + write conventions injected) |
| B5 | Agent `memory:` frontmatter | `user`/`project`/`local` scopes map to `~/.claude/agent-memory/<name>/`, `.claude/agent-memory/<name>/`, `.claude/agent-memory-local/<name>/`; first 200 lines / 25 KB of `MEMORY.md` injected | parsed, no-op | P2 | fixed |
| B6 | Rules scope order | User rules load before (lower priority than) project rules | project-before-user ordering | P3 | fixed |

## C. Hooks

| # | Gap | Claude Code behavior | PiCC before | Pri | Status |
|---|-----|----------------------|-------------|-----|--------|
| C1 | Matcher semantics | Plain names (alnum/`_`/`-`/space) = exact match; `\|` and `,` (v2.1.191) separate alternatives; regex metachars → JS regex tested **unanchored** (substring); case-sensitive | everything compiled as fully-anchored regex | P1 | fixed |
| C2 | stdin fields | Common: `session_id`, `transcript_path`, `cwd`, `permission_mode`, `hook_event_name`; PreToolUse adds `tool_use_id`; Stop adds `last_assistant_message`; PostToolUse `tool_response` is structured | `transcript_path`/`permission_mode`/`tool_use_id` never sent; `tool_response` flattened text | P1 | fixed |
| C3 | `systemMessage` / `suppressOutput` | honored on all events (show message to user; hide stdout from context) | ignored | P1 | fixed |
| C4 | Parallel execution + dedup | matching hooks run in parallel; identical commands deduplicated; merged most-restrictive (deny > ask > allow) | strictly serial, no dedup | P2 | fixed |
| C5 | `async: true` | hook runs in background without blocking | not supported | P2 | fixed (fire-and-forget) |
| C6 | Timeouts | default 60 s; UserPromptSubmit capped 30 s; per-hook `timeout` (seconds) override | flat 60 s | P3 | fixed |
| C7 | Stop-hook loop cap | 8 consecutive blocks, then override (hooks-guide) | 5 | P3 | fixed (Stop 8) |
| C8 | Exit-2 on non-blockable events | shows stderr, continues (SessionStart, PostCompact, …) | treated as block everywhere (call sites mostly ignored it) | P3 | fixed (block only where blockable) |
| C9 | SessionStart `additionalContext` cap | ~10,000 chars per value, silently truncated (issue #64626) | unbounded | P3 | fixed |
| C10 | Agent frontmatter `hooks:` | dispatched while the subagent runs (sub-agents.md) | parsed, never dispatched | P1 | fixed (scoped runner per dispatch) |
| C11 | `hookSpecificOutput.hookEventName` | required by schema (issue #55172) | ignored | P3 | fixed (validated, warning on mismatch) |
| C12 | `${CLAUDE_PLUGIN_DATA}` in hook commands | expanded | only `${CLAUDE_PLUGIN_ROOT}` | P3 | fixed |

Deliberately kept (documented divergences): graceful per-entry skip on invalid matcher (Claude
drops the whole file's hooks, issue #75081 — ours is a strict superset); `ask` downgraded to
allow under the default-permissive posture; prompt/agent/mcp_tool handler types degrade.

## D. Permissions

| # | Gap | Claude Code behavior | PiCC before | Pri | Status |
|---|-----|----------------------|-------------|-----|--------|
| D1 | `Bash(cmd *)` word boundary | space-before-`*` means "space or end of string": `Bash(ls *)` matches `ls` and `ls -la`, never `lsof`; `:*` ≡ ` *` | `git *` did **not** match bare `git` | P1 | fixed |
| D2 | Windows path normalization | paths normalized to POSIX (`C:\Users` → `/c/Users`) before matching; `//c/**` matches drive C; case-insensitive on Windows (v2.1.166; issue #47249) | literal native-form comparison | P1 | fixed |
| D3 | Env-prefix assignments | leading `FOO=bar` participates in matching; deny direction should still catch the underlying command | not stripped | P2 | fixed (deny-direction stripping) |
| D4 | MCP allow rules reject unanchored globs (`mcp__*` allow → warning) | validation warning | silently accepted | P3 | fixed (diagnostic) |

Deliberately kept: quote-aware compound splitting (Claude splits inside quotes — issue #76795 —
ours is safer); allow/ask remain advisory under the default-permissive posture (registry ⚠ entries).

## E. Subagents

| # | Gap | Claude Code behavior | PiCC before | Pri | Status |
|---|-----|----------------------|-------------|-----|--------|
| E1 | Built-in agent types | `general-purpose` (all tools), `Explore` (read-only, skips CLAUDE.md/git status), `Plan` (read-only, skips CLAUDE.md); project agents with the same name override; `CLAUDE_CODE_DISABLE_EXPLORE_PLAN_AGENTS=1` removes Explore/Plan | none — unknown `subagent_type` errored | P1 | fixed |
| E2 | Default agent type | omitted/unknown-with-description → general-purpose one-shot | hard error | P2 | fixed (omitted AND unknown types fall back to general-purpose with a visible degrade note) |
| E3 | Nesting depth | up to 5 levels below the main conversation | default `subagentMaxDepth` 2 | P2 | fixed (default 5) |
| E4 | `run_in_background` | real background execution; results polled via TaskOutput, stopped via TaskStop; `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1` | accepted-but-foreground; TaskOutput/TaskStop stubs | P1 | fixed (background registry + real TaskOutput/TaskStop) |
| E5 | `CLAUDE_CODE_SUBAGENT_MODEL` env | highest-priority model override (`inherit` = unset) | not read | P3 | fixed |
| E6 | Explore/Plan context trimming | built-ins skip CLAUDE.md + git status for speed | n/a | P3 | fixed with E1 |

Deliberately kept: no SendMessage/resume (one-shot dispatch documented); `permissionMode`
no-op (posture).

## F. Settings & environment

| # | Gap | Claude Code behavior | PiCC before | Pri | Status |
|---|-----|----------------------|-------------|-----|--------|
| F1 | `SLASH_COMMAND_TOOL_CHAR_BUDGET` env | overrides skill-listing budget | not read | P3 | fixed |
| F2 | `CLAUDE_CODE_DISABLE_AUTO_MEMORY`, `autoMemoryEnabled`, `autoMemoryDirectory` | control auto memory | n/a (no memory) | P2 | fixed with B4 |
| F3 | `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS`, `CLAUDE_CODE_DISABLE_EXPLORE_PLAN_AGENTS` | disable background tasks / built-in agents | not read | P3 | fixed |
| F4 | `BASH_DEFAULT_TIMEOUT_MS` / `BASH_MAX_TIMEOUT_MS` / `BASH_MAX_OUTPUT_LENGTH` | bash tool limits | not honored | P3 | deferred (Pi SDK owns the bash tool options; documented) |

## Non-goals confirmed by research (registry already truthful)

- AGENTS.md is *not* natively read by Claude Code (issue #6235 open) — the `@AGENTS.md` import
  bridge is the correct behavior.
- MCP, sandboxing, auto/plan permission modes, checkpointing, output styles, statusline remain
  deferred with visible degrades.
- Claude's `Bash(space *)`-vs-`:*` matcher bugs (#29529) are NOT replicated; PiCC treats both
  forms per the documented semantics.

## Second-pass review (same day): multi-angle findings and fixes

Four independent reviews (adversarial diff review, scenario walkthrough, spec-fidelity
re-verification, docs/consistency) ran over the change set. Confirmed findings, all fixed:

| # | Finding (reviewer) | Fix |
|---|--------------------|-----|
| R1 | Skill `disallowed-tools` matched with allow polarity — `echo hi && rm -rf x` and `FOO=1 rm -rf x` evaded an active skill's `Bash(rm *)` (scenario) | guard's extra-deny path now uses deny-direction options + stable anchor; regression test `test/guard-skill-deny-polarity.test.ts` |
| R2 | `async: true` hook handlers silently dropped by the settings/agent normalizers — ran blocking (fidelity) | `async` preserved in both normalizers; integration test proves a settings-sourced async hook doesn't block |
| R3 | UNC deny rules (`Read(//server/share/**)`) could never match `\\server\share\…` inputs (adversarial) | UNC-aware normalization in the glob engine; deny-direction realpath skipped for UNC (multi-second network-stall fix) |
| R4 | `once: true` handlers duplicated across merged settings scopes fired twice (adversarial) | dedup marks duplicate identities as fired |
| R5 | Auto memory was not injected into subagent prompts (fidelity) | injected for all subagents except Explore/Plan (skipProjectContext) |
| R6 | `\\$N` collapsed backslash pairs, deviating from Claude's escape rule (adversarial+fidelity) | even backslash runs kept verbatim + token expands; odd runs escape |
| R7 | Unknown `subagent_type` hard-errored instead of general-purpose fallback (adversarial+fidelity) | fallback with visible degrade note in diagnostics and prompt |
| R8 | Nested `sub:name` qualified names resolvable only on collision (fidelity) | qualified alias always registered |
| R9 | `claudeMdExcludes` could not exclude ancestor CLAUDE.md above the repo root via glob patterns (adversarial) | excludes additionally anchored at the candidate's own dir for out-of-root files |
| R10 | Skill-listing tier-degradation diagnostics channel dead at the only call site (adversarial) | wired through context assembly; surfaced once per tier change |
| R11 | Resident active-skills prompt section unbudgeted — ~180k chars/turn possible (scenario) | same 20k/100k budgets applied per turn with a truncation note |
| R12 | Structured `tool_response` hook payload unbounded + built even with no hooks configured (adversarial) | 50k-char truncation envelope + `hasHooks` payload skip (runner, multiplexer, facade) |
| R13 | Stacked slash invocations duplicated the trailing text (args + re-appended request) (adversarial) | trailing text rendered once, via the last skill's arguments |
| R14 | UserPromptSubmit per-hook timeout could exceed the 30 s ceiling (adversarial) | hard clamp |
| R15 | Async hook setup failures invisible without PICC_DEBUG (adversarial) | surfaced via stderr once per distinct message |
| R16 | TaskStop during queueing still ran the full dispatch (adversarial) | abort re-checked after slot acquire and worktree enter |
| R17 | Agent-scoped hooks' `systemMessage` merged but never shown (fidelity) | surfaced in dispatch diagnostics |
| R18 | Registry notes still said "anchored matcher"; plan doc still listed memory as deferred (docs) | corrected |

Scenario walkthroughs S1–S7 (monorepo hierarchy, skills interplay, subagent×worktree×hooks×memory,
background tasks, built-ins, compaction budgets, permissions) all pass through the extension
surface with the fake-Pi harness; live-Pi e2e coverage listed in `test/e2e-live-pi.test.ts`.

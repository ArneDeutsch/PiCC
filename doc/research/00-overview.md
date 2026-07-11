# 00 — Overview: A GPT/Codex Harness for Claude Code Projects (PiCC)

> **Goal.** Build a harness ("PiCC") that lets GPT/Codex models — run on a personal
> ChatGPT subscription — work on projects authored and tuned for **Claude Code**, with **no changes
> to those projects**. The GPT models should read and use the project's Claude-format skills,
> subagents, hooks, `settings.json` permissions, `CLAUDE.md` hierarchy, and the worktree-based
> workspace isolation (`EnterWorktree`/`ExitWorktree`) that enables parallel sessions on one repo.
>
> **Reference project** (the minimal target to support): `F:/Arne/Projekte/DemonMatrix` — a Rust
> ARPG whose `.claude/` corpus is an elaborate multi-agent, worktree-parallel, git-native workflow
> (24 skills + 9 agents + `tools/dm-*.sh`). We don't need 100 % Claude Code parity — just enough to
> run corpora like this unchanged.
>
> This folder is the research baseline for making concrete development plans. Date: 2026-07-11.

---

## The headline

**Feasible, and the path is concrete.** The recommended base is **Pi** (`earendil-works/pi`, MIT,
TypeScript) — a deliberately minimal, reshapeable coding-agent harness. Pi **already ships the two
hardest things**: spending a **ChatGPT/Codex subscription** (direct-backend auth with the required
`originator: codex_cli_rs` header — the fragile part everyone else avoids) and a **model-agnostic**
provider layer (OpenAI Responses/Completions + Anthropic + Google). Everything DemonMatrix additionally
needs is **additive extension work in Pi's own typed API**: loaders for `.claude/skills` and
`.claude/agents`, a `Task`/`Agent`-equivalent subagent runtime, `EnterWorktree`/`ExitWorktree`, a
`settings.json` permission engine, a `PreToolUse`/`PostToolUse` shell-hook shim, and nested `CLAUDE.md`
injection. Estimated **~2–4 weeks solo** to a working single-session flow.

The build is meaningfully bounded by three facts about the reference corpus: it uses **no MCP**, **no
nested (recursive) subagents** (fan-out is flat, depth 1), and **only `permissions.allow` + `permissionMode: default`** (no deny/ask, no exotic modes).

**Two decisions to make early** (details in `06 §7`): (Q1) fork Pi vs depend-on-Pi + extensions;
(Q2) auth via Pi's *direct-backend* mode (full control, gray-area) vs *subprocess* mode (drive a
signed-in `codex` child, officially supported, less control). Recommendation: **depend + extensions**,
**direct-backend**, validated in a half-day Phase-0 spike.

---

## Documents in this folder

| Doc | What it covers | Read it for |
|---|---|---|
| **00** (this) | Executive overview, index, reading guide | Orientation |
| **[01 — DemonMatrix Claude usage](01-demonmatrix-claude-usage.md)** | Reference-grade inventory of every Claude Code feature the project relies on: 24 skills, 9 agents, settings/permissions, hooks, worktrees, subagent dispatch, `dm-*.sh` scripts, `CLAUDE.md` hierarchy; ends with a **feature-support checklist** and a "not required" list | The **requirements** the harness must satisfy |
| **[02 — Claude Code internals](02-claude-code-internals.md)** | How Claude Code implements Skills, Subagents, Hooks (~30 events + stdin/stdout contract), `settings.json` (5-tier precedence), slash commands (now merged into Skills), memory/`CLAUDE.md`, and the permission model — enough to re-implement | The **exact contracts** to mimic |
| **[03 — Worktrees & git](03-worktrees-and-git.md)** | The `EnterWorktree`/`ExitWorktree` contract from live DemonMatrix evidence (incl. the `CLAUDE_BASE` file, `worktree-<name>` leftover branch, `mode=` detection, merge/reap), git-worktree mechanics, hooks across worktrees, **Windows specifics**, and a concrete implementation spec | Building the **worktree tools** |
| **[04 — The Pi harness](04-pi-harness.md)** | Identifies Pi (`earendil-works/pi`), its layered architecture, the extension/plugin API (`registerTool`, lifecycle hooks), subscription OAuth, subagent/worktree status, Windows setup, and a **suitability rating (recommended)** | Understanding & rating **the base** |
| **[05 — Codex & alternatives](05-codex-and-alternatives.md)** | OpenAI Codex CLI formats (`AGENTS.md`, `config.toml`, per-agent `.codex/agents/*.toml`, skills, hooks), the **critical subscription-auth mechanics** (supported subprocess path vs gray-area direct-backend), and a scored survey of alternatives (opencode, Goose, Cline, OpenHands, Crush, Aider, routing Claude Code) | **Auth reality** + whether to build at all |
| **[06 — Gap analysis & plan](06-gap-analysis-and-plan.md)** | The synthesis: harness recommendation, auth decision, a full **requirements→Pi capability matrix** with effort estimates, proposed architecture, a **phased build plan**, open questions, further research, and a risk register | **What to build and in what order** |

**Suggested reading order:** 00 → 06 (the plan) → dip into 01/03 for exact contracts when building →
04 for the Pi API → 02/05 as reference.

---

## What the reference project actually uses (the surface to support)

From `01`, the Claude Code primitives DemonMatrix depends on — the harness must reproduce these:

- **Skills** at `.claude/skills/<name>/SKILL.md` — frontmatter (`name`, `description`,
  `user-invocable`, `argument-hint`, `metadata.portability`), progressive-disclosure bundle files,
  **skills that compose other skills by name**, and **slash commands = `user-invocable: true` skills**
  (there is no `.claude/commands/` dir).
- **Subagents** at `.claude/agents/*.md` — `name/description/tools/color/permissionMode/metadata`,
  where the **`description` field is the routing key** (agents "own" path globs; ≥60 % ownership →
  that agent leads) and **`tools:` gates write capability**.
- **Subagent dispatch** — a **thin-dispatcher** orchestrator that issues **fresh-context** `Agent`
  (formerly `Task`) invocations, fans them out **in parallel**, and captures **only the verbatim final
  message** (a locked-YAML block). Flat, depth-1.
- **Worktrees** — `EnterWorktree(name:|path:)` / `ExitWorktree` under `.claude/worktrees/<flat>/`,
  `settings.json → worktree.baseRef: "head"`, a branch grammar (`m<NN>/<f|c><NN>-<slug>`), and a
  merge/reap lifecycle enabling **parallel sessions on one repo** (unit of parallelism = the worktree).
- **Hooks** — `PreToolUse` (warn-only worktree write-guard, via stdin JSON + stdout
  `permissionDecision`) and `PostToolUse` (with an **`if:` conditional**) that self-heals
  `core.hooksPath=.githooks` so a 21 KB `pre-commit` gate fires on every commit.
- **Permissions** — `settings.json`/`settings.local.json` **allow-lists** with matchers
  (`Bash(git:*)`, `Bash(tools/dm-*.sh:*)`, `WebFetch(domain:*)`, `Read(<glob>)`); commands are
  deliberately shaped as single `dm-*.sh` invocations so a static matcher can approve them.
- **`CLAUDE.md` hierarchy** — root + **9 per-crate/tool** files, auto-injected when the model reads a
  file in that directory.

**Explicitly not needed:** MCP servers, `allowed-tools` in skill frontmatter, `deny`/`ask` rules,
`permissionMode` values beyond `default`, nested subagents. (See `01` "Not required" + `06 §4.8`.)

---

## The subscription-auth reality (why Pi matters)

A ChatGPT subscription entitles the **Codex product surface**, a *separate billing system* from the
per-token Responses API — you **cannot** spend it through `api.openai.com`. The only ways to spend it
(`05 §A.5`):

- **Direct-backend** — call `chatgpt.com/backend-api/codex/responses` with the OAuth token from
  `~/.codex/auth.json` **and** `originator: codex_cli_rs` (an edge whitelist; a wrong originator →
  403). **Pi already implements this** (fix verified in Pi's issue #1828). Gray-area but tolerated for
  personal single-account use — OpenAI's DevEx lead named Pi explicitly as a blessed client. *Account
  pooling/sharing is a clear ToS violation.*
- **Subprocess** — drive a signed-in `codex` (`codex mcp-server` / `exec --json` / `@openai/codex-sdk`)
  as a child; officially supported; you inherit Codex's loop and lose fine control.

This is the crux of the whole idea, and Pi's having solved the hard (direct-backend) path is the main
reason it's the recommended base rather than opencode (fallback) or routing Claude Code (zero-build
stopgap). See `06 §2–3`.

---

## Recommendation in one paragraph

Build PiCC as a thin **extension bundle on Pi**: a `.claude/skills` loader, a `.claude/agents`
loader + flat parallel subagent runtime returning verbatim locked-YAML, `EnterWorktree`/`ExitWorktree`
(git worktree + cwd swap + `CLAUDE_BASE` + Windows best-effort-remove/reap), a `settings.json`
allow-list permission engine on Pi's `tool_call` hook, a `PreToolUse`/`PostToolUse` shell-hook shim
(stdin JSON + stdout decision + `if:`), and nested `CLAUDE.md` injection. Reproduce the ~10 runtime
primitives and the DemonMatrix corpus runs unchanged — because the corpus is encoded as *data*, not as
harness features. Start with a half-day Phase-0 auth spike, then build in the order in `06 §6`, testing
each phase against DemonMatrix. **The two genuinely hard problems are already done in Pi; the rest is
well-specified, bounded work.**

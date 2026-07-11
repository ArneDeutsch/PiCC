# 05 — OpenAI Codex CLI & Alternative Harnesses

> Research for a **new agentic harness that runs GPT/Codex models on Claude-Code-authored projects**.
> Compiled **2026-07-11**. Prefer primary sources (openai/codex repo, learn.chatgpt.com docs) over blogs.
> Fast-moving domain — model names, rate-limit numbers, and star counts are point-in-time; verify at read time.

## TL;DR — the two questions that matter most

**(1) How GPT-subscription auth realistically works for a third-party harness.**
A ChatGPT subscription (Plus/Pro/Business/Enterprise, and now Free/Go tiers) entitles the **Codex product surface** (CLI, IDE, cloud, MCP, SDK) — it is a *separate billing system* from the pay-per-token Responses API on `api.openai.com`. When you `codex login` via "Sign in with ChatGPT", Codex sends model traffic to an **undocumented ChatGPT backend endpoint** `https://chatgpt.com/backend-api/codex/responses` (not `api.openai.com`), authenticated by the OAuth `access_token` in `~/.codex/auth.json`. There are two ways a third-party harness can spend that subscription:

- **Supported / clean path — drive the user's signed-in Codex as a subprocess.** `codex mcp-server` (stdio JSON-RPC MCP), `codex exec --json` (headless JSONL), or the official `@openai/codex-sdk` (which itself spawns the CLI). All inherit `~/.codex/auth.json`, so all consume the subscription, and you never touch the token yourself.
- **Gray-area path — read `auth.json` and call the backend directly.** Widely practiced (LiteLLM `chatgpt/` provider, opencode plugin, simonw/llm-openai-via-codex, and **Pi itself**). It works, but OpenAI enforces an **`originator` header whitelist at the Cloudflare edge** — you must send `originator: codex_cli_rs` (impersonating the official CLI) or you get a **403 / `cf-mitigated: challenge`**. This is *exactly* the bug the user's own project hit and fixed: [`badlogic/pi-mono` #1828](https://github.com/badlogic/pi-mono/issues/1828). Personal single-account use is tolerated and even verbally endorsed (Romain Huet, OpenAI, named "Pi" specifically — see §A.5); **account pooling / credential sharing is a clear ToS violation.**

**(2) Does an existing tool already solve "run GPT on a `.claude/` project"?** Largely, yes — you may not need to build from scratch:
- **Route Claude Code itself onto GPT** (keeps 100% native `.claude/` reading, only swaps the model): `claude-code-router` (~35.7k★) or OpenRouter's official Claude Code integration. This is the *most complete* answer if you can tolerate GPT tool-calling being weaker than Claude's through the Anthropic protocol.
- **A non-Claude harness that natively reads `.claude/` with GPT:** only *partial* coverage exists. **opencode** reads `CLAUDE.md` + `.claude/skills/` with any model (incl. Codex subscription auth) but **not** `.claude/agents/`, `.claude/commands/`, `settings.json`, or hooks. **Goose** reads `.claude/skills` and is landing `.claude/` subagent parsing.
- **The genuine gap** (and the value of building): no mature non-Claude harness ingests the **full** `.claude/` set — `agents/` subagents + `commands/` + `settings.json` + hooks — and runs it on a GPT/Codex subscription. The user's **Pi** already has Codex subscription auth working; adding `.claude/`-format ingestion on top is the under-served niche.

---

# PART A — OpenAI Codex CLI (`codex`)

**What it is:** OpenAI's official open-source coding agent CLI, written in **Rust** (`codex-rs`), Apache-2.0, repo [`openai/codex`](https://github.com/openai/codex). Docs migrated: `developers.openai.com/codex/*` now **308-redirects** to `learn.chatgpt.com/docs/*`. As of mid-2026 the default model is in the **GPT-5.6 "Sol"** family.

## A.1 — Config & memory formats (AGENTS.md, config.toml, CODEX_HOME)

### `AGENTS.md` — the memory/instructions convention

Codex's native memory file is **`AGENTS.md`** (not `CLAUDE.md`). Discovery is a layered chain that Codex concatenates root-first into one instruction block, so files **closer to the CWD win** (they appear later and override):

1. **Global** — in `$CODEX_HOME` (default `~/.codex`): `AGENTS.override.md` if present, else `~/.codex/AGENTS.md`.
2. **Project** — walk from the Git/project root *down* to the CWD; in each dir check `AGENTS.override.md` → `AGENTS.md` → any names in `project_doc_fallback_filenames`. At most one file per directory.
3. **Merge** — concatenated root→CWD, joined by blank lines.

Constraints: `AGENTS.override.md` beats `AGENTS.md` in the same dir; empty files skipped; combined size capped by `project_doc_max_bytes` (**default 32 KiB**); chain rebuilt each session. (Historical bug [#8759] meant the global `~/.codex/AGENTS.md` wasn't read by default; discovery was later refactored into an `AgentsMdManager`, PR [#18035].)

**AGENTS.md is an open cross-tool standard** — originated at OpenAI (2025), now governed under the Linux Foundation's Agentic AI Foundation and published at [agents.md](https://agents.md/). Honored natively by ~28+ tools (Codex, GitHub Copilot, Cursor, Windsurf, Amp, Devin, Aider, Zed, Warp, Roo Code, Google Jules, JetBrains Junie, Factory, VS Code).

**vs. Claude Code's `CLAUDE.md`:** same concept (a Markdown memory file of build/test commands, conventions, boundaries) and a very similar hierarchical/merge model (global `~/.claude` → project root → subdir). Differences: `CLAUDE.md` is Claude Code's primary file and is richer (`@path` imports); `AGENTS.md` adds the distinctive `AGENTS.override.md` and `project_doc_fallback_filenames` mechanisms. **Claude Code now also reads `AGENTS.md`**, but `CLAUDE.md` stays its primary format — so **AGENTS.md is the portable layer, CLAUDE.md the Claude-specific superset.** Neither tool auto-falls-back to the other's file; users bridge via symlink (`ln -s AGENTS.md CLAUDE.md`) or a `@AGENTS.md` import inside `CLAUDE.md` (import is the Windows-safe method — symlinks need Developer Mode).

### `~/.codex/config.toml` and `$CODEX_HOME`

`$CODEX_HOME` is the env var for Codex's home directory; **default `~/.codex`**. It holds `config.toml`, `AGENTS.md`, `auth.json`, `prompts/`, `skills/`, `agents/`, `hooks.json`, and logs. Config is **TOML**. Project-level config exists (`.codex/config.toml`) but a few keys (`openai_base_url`, `chatgpt_base_url`, `notify`, some provider settings) **cannot** be overridden at project scope and are ignored there.

Actual top-level keys (from the official Configuration Reference):

| Area | Keys |
|---|---|
| Model | `model` (e.g. `"gpt-5.6"`), `model_provider`, `model_context_window`, `model_auto_compact_token_limit`, `model_reasoning_effort` (`minimal\|low\|medium\|high\|xhigh`), `plan_mode_reasoning_effort`, `model_reasoning_summary` (`auto\|concise\|detailed\|none`), `model_verbosity` (`low\|medium\|high`) |
| Security | `approval_policy` (`untrusted\|on-request\|never`, or a granular object), `sandbox_mode` (`read-only\|workspace-write\|danger-full-access`), `[sandbox_workspace_write]` (`network_access`, `writable_roots`) |
| Docs | `project_doc_fallback_filenames`, `project_doc_max_bytes` (32 KiB) |
| Tables | `[mcp_servers.NAME]`, `[profiles.NAME]`, `[[skills.config]]`, `[windows]`, `[hooks]` |

Representative `config.toml` (TOML requires root keys before tables):

```toml
model = "gpt-5.6"
model_reasoning_effort = "medium"
plan_mode_reasoning_effort = "high"
model_reasoning_summary = "auto"
approval_policy = "on-request"
sandbox_mode = "workspace-write"
notify = ["/bin/bash", "/Users/you/.codex/hooks/notify.sh"]  # user-scope only

[sandbox_workspace_write]
network_access = false
writable_roots = ["/tmp/codex"]

[mcp_servers.docs]
command = "docs-server"
args = ["--port", "4000"]
tool_timeout_sec = 60.0

[profiles.review]
model = "gpt-5.6"
model_reasoning_effort = "high"
approval_policy = "never"
sandbox_mode = "read-only"

[[skills.config]]
path = "/path/to/skill/SKILL.md"
enabled = false
```

## A.2 — Agent / subagent definitions (the REAL format)

The user's guess of a single **`agent.toml`** is *close but wrong*. There are two distinct concepts:

- **Profiles** — named config layers, defined as **`[profiles.NAME]` tables** in `config.toml`. Any top-level key inside overrides the base when you run `codex --profile NAME`. Profiles switch model/reasoning/approval/sandbox — **they don't spawn anything.**
- **Custom agents** — standalone **per-agent TOML files** (one file each, *not* a single `agent.toml`):
  - Personal: `~/.codex/agents/<name>.toml`
  - Project: `.codex/agents/<name>.toml`
  - Required keys: `name`, `description`, `developer_instructions`. Optional (inherit from parent if omitted): `model`, `model_reasoning_effort`, `sandbox_mode`, `mcp_servers`, `skills.config`, `nickname_candidates`.

**Does Codex support subagents? YES** — new in 2026, experimental but enabled by default. Codex spawns specialized child agents in parallel and collects results in one response. Invocation:
- Natural language ("spawn two agents", "delegate this in parallel") — launches only when you explicitly ask for parallel/agent work, or an AGENTS.md/skill requests delegation.
- `/agent` slash command inspects/switches running agent threads.
- `spawn_agents_on_csv` tool — one worker subagent per CSV row (experimental).

Caveats: subagents multiply token cost; OpenAI notes the feature "may change"; open bug [#14161] — `[[skills.config]]` inside a sub-agent TOML is ignored — so treat agent-file skill overrides as not-fully-reliable yet. (Also note: Claude Code's own subagents are hard-locked to Claude models, which is *why* the router approach in Part B exists.)

## A.3 — Skills / prompts / custom slash commands

**Custom prompts (slash commands): supported but DEPRECATED.**
- Location: top-level Markdown in `~/.codex/prompts/*.md` (no subdir scan).
- Invoked via slash menu: `draftpr.md` → `/prompts:draftpr`. Args: positional `$1`–`$9`, named `KEY=value` placeholders, `argument-hint` in YAML frontmatter.
- Docs now say: "Use skills for reusable prompts." Prompts are local-only (not shared via the repo).

**Skills: YES — Codex adopted an Anthropic-style `SKILL.md` system (2025/2026).**
- A skill = a directory with `SKILL.md` (frontmatter requires `name` + `description`; the description drives implicit auto-selection) plus optional scripts/references.
- Locations (project > user > system): project **`.agents/skills/`** (scanned CWD→repo-root, committed to repo), user `~/.codex/skills/`, system `~/.codex/skills/.system` (ships built-in `plan` + `skill-creator`) and `/etc/codex/skills`.
- Config: `[[skills.config]]` (`path`, `enabled`) in `config.toml`. Invoke via `/skills`, `$mention`, or implicit description match.
- **Cross-tool:** Codex's `.agents/skills` + `SKILL.md` follows the **Agent Skills open standard** ([agentskills.io](https://agentskills.io/specification), published by Anthropic Dec 2025, now under the Linux Foundation AAIF; ~32 adopting tools incl. Claude Code, Codex, Gemini CLI, Cursor, Goose, Cline, Windsurf, opencode). So Claude skills are **format-compatible** with Codex — but Codex scans `.agents/skills/` / `~/.codex/skills/`, **not `.claude/skills/`**, so Claude skills must be copied/symlinked into a Codex-scanned dir.

## A.4 — Hooks / lifecycle (and `notify`, MCP, approvals)

**Codex now has a full hook system closely analogous to Claude Code hooks**, *plus* a separate legacy `notify`.

**Hook system** — configured via `~/.codex/hooks.json`, project `.codex/hooks.json`, or inline `[hooks]` in `config.toml` (layered: user → repo → plugin). **Ten lifecycle events** (nearly 1:1 with Claude Code):
`SessionStart` (matchers `startup\|resume\|clear\|compact`), `SubagentStart`, `PreToolUse` (matchers = tool names, e.g. `^Bash$`, `apply_patch`), `PermissionRequest`, `PostToolUse`, `PreCompact`/`PostCompact`, `UserPromptSubmit`, `SubagentStop`, `Stop`.
Only `type = "command"` executes today (`prompt`/`agent` handler types are parsed but reserved). Command hooks get JSON on **stdin** (`session_id`, `turn_id`, `cwd`, `hook_event_name`, `permission_mode`) and can return JSON (`continue`, `stopReason`, `systemMessage`, `suppressOutput`); exit code `2` + stderr signals block. Disable via `[features] hooks = false`; enterprises can force `allow_managed_hooks_only`.

```toml
[[hooks.PreToolUse]]
matcher = "^Bash$"
[[hooks.PreToolUse.hooks]]
type = "command"
command = '/usr/bin/python3 ".codex/hooks/script.py"'
timeout = 30
```

**`notify`** (older, separate) — a `notify = ["/bin/bash", ".../notify.sh"]` array; Codex appends one JSON arg describing the event. **Only `agent-turn-complete` is emitted today** (payload: `type`, `turn-id`, `input-messages`, `last-assistant-message`). User-scope only (ignored in project config); must precede any `[table]`.

**MCP** — servers configured via **`[mcp_servers.NAME]`** (transport inferred: `command` ⇒ stdio, `url` ⇒ Streamable HTTP). Keys: `command`/`args`/`env`/`cwd`, `url`/`bearer_token_env_var`/`auth` (`oauth`\|`chatgpt`), `startup_timeout_sec` (10), `tool_timeout_sec` (60), `enabled`/`enabled_tools`/`disabled_tools`, per-tool `approval_mode`. Management CLI: `codex mcp add|list|get|remove|login|logout`. **Codex can itself be an MCP server:** `codex mcp-server` (stdio JSON-RPC, exposes `codex`/`codex-reply` tools) — the cleanest way for another harness to drive it. *(Naming drifted across releases: serve mode was historically `codex mcp`; current reference uses `codex mcp-server`. Known bug: project-local `.codex/config.toml` MCP servers ignored in some builds — #3441/#13025.)*

**Approvals** — `approval_policy` = `untrusted` / `on-request` / `never` (or a granular object with `sandbox_approval`, `rules`, `mcp_elicitations`, `request_permissions`, `skill_approval`). `on-failure` is **deprecated** (older docs list the classic four: untrusted/on-failure/on-request/never).

## A.5 — Model + AUTH (the CRITICAL section)

### Auth methods

Three modes (`learn.chatgpt.com/docs/auth`):
- **Sign in with ChatGPT (OAuth)** — `codex login` → browser. Consumes ChatGPT-plan usage; no API key.
- **API key** — `printenv OPENAI_API_KEY | codex login --with-api-key` (or the `OPENAI_API_KEY` env var). Billed at standard **per-token API** rates.
- **Enterprise access token** — `codex login --with-access-token` / `--device-auth` (headless).

**OAuth flow (source-verified in `codex-rs/login/src/`):** OAuth 2.0 + **PKCE (S256)** against issuer `https://auth.openai.com`. Local callback HTTP server on **port 1455** (fallback 1457), redirect `http://localhost:{port}/auth/callback`. **`client_id = app_EMoamEEZ73f0CkXaXp7hrann`** (public constant). Scopes: `openid profile email offline_access api.connectors.read api.connectors.invoke`, plus `codex_cli_simplified_flow=true`.

**Credential storage — `~/.codex/auth.json`** (mode `0600`; backend selectable via `cli_auth_credentials_store` = `file`|`keyring`|`auto`):
- Top-level keys (`AuthDotJson`): **`OPENAI_API_KEY`**, **`tokens`**, **`last_refresh`**, `auth_mode`, `agent_identity`, `personal_access_token`, `bedrock_api_key`.
- **`tokens`** (`TokenData`): **`id_token`**, **`access_token`** (JWT used for requests), **`refresh_token`**, **`account_id`**.
- The `id_token` JWT carries `email`, **`chatgpt_plan_type`**, `chatgpt_user_id`, `chatgpt_account_id` (parsed *without* signature verification).
- **Refresh:** automatic; refreshes when access token expires within 5 min OR >8 days since `last_refresh` (`TOKEN_REFRESH_INTERVAL = 8` days). `POST https://auth.openai.com/oauth/token` with `grant_type=refresh_token`. Shared between CLI and IDE extension.

### Subscription entitlement, limits, models

- **Plans including Codex:** Free, Go, Plus, Pro, Business, Edu, Enterprise ("Team" folded into Business). Timeline: cloud Codex launched May 16 2025 (Pro/Team/Enterprise); "Sign in with ChatGPT" + included usage relaunched ~Aug 27 2025; GPT-5-Codex became default ~Sep 2025.
- **Rate limits:** a **shared 5-hour rolling window** (CLI + IDE + cloud) **plus a weekly limit** (added ~Nov 2025). Tiers as multiples of Plus: Pro $100 = 5×, Pro $200 = 20×, Business ≈ Plus, Enterprise scales with workspace credits. Metered in **credits** (~5–40/message); a credit/overage purchase system was added late-2025→2026. Per-plan integers are re-tuned each model generation — approximate.
- **Models on the subscription path (mid-2026):** `gpt-5.6-sol` (flagship/default at medium reasoning), `gpt-5.6-terra`, `gpt-5.6-luna`, `gpt-5.5`, `gpt-5.4`, `gpt-5.4-mini`, `gpt-5.3-codex-spark` (Pro preview). **"Sol" is the public name of the GPT-5.6 flagship**, not a hidden codename. Older `gpt-5` / `gpt-5.1-codex-max` / `gpt-5.2-codex` / `o3` / `codex-mini-latest` were real but have been deprecated from the current picker (a wave ~Apr 14 2026). *(These 5.5/5.6 names post-date the Jan-2026 knowledge cutoff and were corroborated by multiple 2026 sources — verify at `learn.chatgpt.com/docs/models`.)*
- **Reasoning effort:** subscription users select per-model — Low / **Medium (default)** / High / Extra High / Max / Ultra (Ultra runs parallel agents). Set via `/model` or `model_reasoning_effort`. Works identically under ChatGPT and API-key auth.

### THIRD-PARTY REUSE — can a harness spend the subscription? (the core question)

**Yes — a real, widely-practiced, semi-tolerated pattern for personal single-account use, but on an undocumented, edge-gated endpoint; pooling/sharing is against ToS.**

**Mechanism (community reverse-engineering, corroborated + verified):**
- Signed in with ChatGPT, Codex routes traffic to **`https://chatgpt.com/backend-api/codex/responses`** — the ChatGPT backend, *not* `api.openai.com`. (Older internal base `.../wham` a.k.a. "WHAM" also exists.)
- **Required headers:** `Authorization: Bearer <access_token>`, `ChatGPT-Account-Id: <account_id>` (casing matters), **`originator: codex_cli_rs`** (or `codex_vscode` / `codex_sdk_ts`), a matching versioned `User-Agent` (e.g. `codex_cli_rs/0.0.1`), `OpenAI-Beta`; body must set `store=false` and `input_text` typing.
- **KEY ENFORCEMENT:** OpenAI enforces the **`originator` header as a Cloudflare-edge whitelist**. A non-recognized originator → **403 / `cf-mitigated: challenge`**. Detection has tightened across Codex releases. **Verified in the user's own project:** [`badlogic/pi-mono` #1828](https://github.com/badlogic/pi-mono/issues/1828) — Pi sent `originator: pi`, got 403; fix was to send `originator: codex_cli_rs`, PascalCase `ChatGPT-Account-Id`, and a versioned UA (~15 LOC). So **a from-scratch harness that hits the backend directly must impersonate `codex_cli_rs`.**

**Community projects that do this:** LiteLLM's first-class **`chatgpt/` provider** (OAuth device flow + token caching, most mainstream); `simonw/llm-openai-via-codex` (reads `~/.codex/auth.json`); opencode plugins `numman-ali/opencode-openai-codex-auth`, `open-hax/codex`, `tumf/opencode-openai-device-auth`; proxies `codex-cursor-proxy`, `Securiteru/codex-openai-proxy`; and `Soju06/codex-lb` (multi-account load balancer — **the ToS-violating case**). **Pi** itself is in this category.

**Official vs gray vs forbidden:**
- **Semi-official (verbal only):** Romain Huet (OpenAI, Head of DevEx), tweet **2026-03-30**: *"We want people to be able to use Codex, and their ChatGPT subscription, wherever they like… JetBrains, Xcode, OpenCode, **Pi**, and now Claude Code."* Peter Steinberger: "OpenAI sub is officially supported." **These name Pi explicitly** — the strongest endorsement, but a tweet, not written policy. (Verified via Simon Willison, 2026-04-23.)
- **Gray:** the endpoint is undocumented and "can change without notice"; "wherever you like" effectively means "from a client whose originator the WAF recognizes."
- **Forbidden (written ToS):** sharing account credentials, making your account available to others, programmatically extracting output except through the API, and circumventing rate limits/protective measures → **account pooling, credential sharing, reselling are clear violations.** There is *no* explicit clause forbidding pointing an unofficial client at *your own* OAuth token — a maintainer (Discussion #8338) confirmed the CLI is forkable (Apache-2.0) but declined to affirmatively bless subscription-token reuse from a modified client. **Deliberately unresolved gray zone.**
- **Ban risk:** no confirmed ban tied specifically to personal third-party OAuth reuse; enforcement is at the edge (403), not (yet) account bans. Precedent looms — **Anthropic** banned consumer-plan OAuth tokens in third-party tools (terms Feb 20 2026, enforced Apr 4 2026); secondary reports say OpenAI had **not** done the equivalent as of mid-2026.

### The realistic SUPPORTED path for a new harness

Because the subscription authorizes the *Codex product*, not the *Responses API*, the only supported way to spend it is to **drive the user's own signed-in Codex install as a subprocess** — never harvest the token:

1. **`codex mcp-server`** (recommended) — Codex as a stdio JSON-RPC MCP server; your harness is the MCP client. Inherits `auth.json`. Experimental but clean.
2. **`codex exec --json`** — headless JSONL event stream (`thread.started`, `turn.completed`, `item.*`); `--output-schema` for structured output.
3. **`@openai/codex-sdk` (TS)** / `openai-codex` (Python beta) — the official embed SDK *spawns the CLI over JSONL*, inheriting ChatGPT login (auth inheritance is by-mechanism, not explicitly documented — test it).

**Not supported:** using the subscription via the public Responses API (`api.openai.com` + `OPENAI_API_KEY` = separate, per-token billed); lifting the token out of `auth.json` to call OpenAI backends from your own code.

> **Design implication for this project:** two viable modes. **(a) Subprocess mode** — spawn `codex mcp-server`/`exec`; fully supported, subscription-billed, no ToS risk, but you inherit Codex's tool loop and lose fine control. **(b) Direct-backend mode** (what Pi does) — read `auth.json`, call `chatgpt.com/backend-api/codex/responses` with `originator: codex_cli_rs`; full control, subscription-billed, but gray-area and edge-fragile (must track originator/UA changes). Pi has already solved (b).

## A.6 — Worktrees / parallelism & sandbox

- **Headless:** `codex exec` (alias `codex e`) — `--json`, `--sandbox`, `-o <file>`, `-m`.
- **Resume:** `codex resume [ID]` / `--last` / `--all`; `codex exec resume`. Transcripts stored locally.
- **Git worktrees:** a **ChatGPT desktop-app feature, NOT the CLI** ("Worktrees are available only in Codex in the ChatGPT desktop app" — each task gets its own worktree, shared `.git`, retained-limit default 15). For the CLI, worktree parallelism is manual (`git worktree add` + separate `codex` sessions).
- **Cloud/parallel:** `codex cloud` / `codex cloud exec` / `codex cloud list` (async OpenAI-managed envs, PR creation, `--attempts 1-4`). Multiple local worktree agents in parallel = experimental.
- **Sandbox (`sandbox_mode`):** `read-only`, `workspace-write` (`[sandbox_workspace_write]` → `writable_roots`, `network_access`, `exclude_slash_tmp`), `danger-full-access`. Per-OS: **macOS** Seatbelt (`sandbox-exec` + generated SBPL); **Linux** `codex-linux-sandbox` = Landlock (FS) + seccomp (network); **Windows — native sandbox supported, WSL NOT required.**
- **Windows specifics:** native Windows sandbox via **restricted tokens** (OpenAI blog "Building a safe... sandbox... on Windows"). `[windows] sandbox = "elevated"` (preferred; dedicated low-priv users + firewall) or `"unelevated"` (ACL fallback); `sandbox_private_desktop = true` default. **Windows 11 recommended** (Win10 1809+ "less reliable"); needs `winget` + ConPTY. WSL now optional (only for the Linux sandbox model).

---

# PART B — Alternative harnesses

> Legend for the quick lines: **Sub-auth** = native "Sign in with ChatGPT"/Codex subscription; **`.claude/`** = reads Claude Code's `.claude/` tree (skills/agents/commands).

## B.0 — OpenAI Codex CLI (as a fork/extend base)
- **Lang/License:** Rust / **Apache-2.0** (clean for forking). **Windows:** native (incl. sandbox).
- **Sub-auth:** it *is* the reference implementation of ChatGPT sign-in. **Model-agnostic:** no — OpenAI-only by design (though `model_providers` allows OpenAI-compatible endpoints). **Custom tools:** MCP (client + server). **Hooks:** full (§A.4). **Subagents:** yes (experimental). **Worktrees:** desktop-app only.
- **`.claude/`:** reads `AGENTS.md` + `SKILL.md` (in `.agents/skills`), **not** `.claude/` paths.
- **Fit:** best-in-class Codex auth and the most Claude-Code-like feature set (hooks, skills, subagents), but Rust and OpenAI-only. Forking it to add multi-provider + `.claude/` reading is a large undertaking against a fast-moving upstream.

## B.1 — opencode (SST → "Anomaly") — **strongest non-Claude base for this goal**
- **Lang/License:** TypeScript on **Bun** (Vercel AI SDK for providers, OpenTUI) / **MIT**. `sst/opencode` → now [`anomalyco/opencode`]; ~v1.17.18 (2026-07-09). **Windows:** native (beta desktop app). **Maturity:** ~178–185k★ (order-of-magnitude), 800+ releases, very rapid.
- **Sub-auth:** **YES** via OpenAI's Codex OAuth (PKCE + device code) — *conflict in sources on native-core vs. plugin `numman-ali/opencode-openai-codex-auth`; verify against the exact fork.* Anthropic Pro/Max OAuth was *removed* ~Mar 2026 under ToS pressure. **Model-agnostic:** 75+ providers via Vercel AI SDK / Models.dev. **Custom tools:** first-class **JS/TS plugin API** (`@opencode-ai/plugin`, 30+ event hooks, `tool()` + Zod, `worktree` in context) + **MCP** (stdio/http/sse). **Subagents:** yes (Build/Plan + General/Explore/Scout + custom `.opencode/agents/*.md`). **Worktrees:** first-class in plugin context; native parallel-worktree still an open request.
- **`.claude/` (verified):** reads **`AGENTS.md` → `CLAUDE.md` fallback**, global `~/.config/opencode/AGENTS.md → ~/.claude/CLAUDE.md`, and **`.claude/skills/`** (project + `~/.claude/`). Toggle via `OPENCODE_DISABLE_CLAUDE_CODE[_PROMPT|_SKILLS]=1`. **Does NOT read `.claude/agents/` or `.claude/commands/`.**
- **Fit:** the only base that already does the two things that matter (Codex subscription auth + reads `CLAUDE.md`/`.claude/skills`) *and* has real subagents, MCP, and a clean JS/TS plugin API. MIT. Main gap to fill: `.claude/agents/` + `commands/` + `settings.json`/hooks ingestion.

## B.2 — Crush (Charmbracelet)
- **Lang/License:** **Go** (~98%, Bubble Tea) / **FSL-1.1-MIT** (Functional Source License → converts to MIT after 2 yrs; *not* standard OSI — flag for commercial use). ~v0.84.0 (2026-07-10). **Windows:** first-class native. **Maturity:** ~26k★, backed by Charm.
- *Naming history:* the original Go "OpenCode" (Kujtim Hoxha + SST); when Charm hired Hoxha and moved the repo in-house, SST objected; resolution (~Jul 2025): **Charm → "Crush"** (Go continuation), **SST kept "opencode"** (TS rewrite). Not forks of each other today.
- **Sub-auth:** **NO** — explicitly declined (issue #2023 closed *not planned*). OpenAI = API-key only. Anthropic OAuth *was* supported, removed 2026-01-07 (PR #1783). **Model-agnostic:** yes (many providers + Charm's hosted "Hyper" + local). **Custom tools:** MCP + Agent Skills (`SKILL.md`); no general plugin API. **Subagents:** **NO** (repeatedly requested). **Worktrees:** none native.
- **`.claude/`:** reads `AGENTS.md` (first-class) and concatenates `CLAUDE.md`/`GEMINI.md`/`CRUSH.md`/`.cursorrules`/copilot-instructions as context; reads **`.claude/skills/`**. Not `.claude/agents/`/`commands/`.
- **Fit:** clean Go/TUI base but you'd have to add *both* Codex auth and subagents (both absent/declined upstream); FSL license nuance.

## B.3 — Aider
- **Lang/License:** **Python** (~80%) / **Apache-2.0** (most business-friendly). ~v0.86.2 (2026-02-12); cadence has **slowed** (solo maintainer Paul Gauthier). **Windows:** native (`pip`), WSL2 recommended. **Maturity:** ~45k★.
- **Sub-auth:** **NO** — strictly API-key/credentials via **LiteLLM** (~100+ providers); no OAuth/ChatGPT sign-in. **Custom tools:** **no native MCP** (third-party wrappers only), no plugin API. **Subagents:** **NO** (Architect/Editor = two models, one agent). **Worktrees:** none native (deep git auto-commit instead).
- **`.claude/`:** **no auto-discovery of any rules file** — `AGENTS.md`/`CLAUDE.md`/`CONVENTIONS.md` are read only if manually passed (`--read`). No `.claude/` support.
- **Fit:** weakest for this goal — no subscription auth, no MCP, no subagents, no Claude-format discovery, slowing dev. *But note:* LiteLLM is the exact library whose `chatgpt/` provider does Codex subscription auth, so Aider could inherit it in principle.

## B.4 — Goose (Block) — **best `.claude/`-format compatibility**
- **Lang/License:** Rust + TS Electron UI / **Apache-2.0**. ~v1.41.0 (2026-07-03), rapid cadence, backed by Block (contributed to Linux Foundation AAIF). **Windows:** native (desktop + CLI; keyring flaky — use env keys). **Maturity:** ~51k★.
- **Sub-auth:** **indirect only** — native OpenAI provider is API-key; ChatGPT subscription via **ACP delegation** (`GOOSE_PROVIDER=codex-acp` wrapping the Codex CLI's own OAuth — i.e. subprocess mode). Same ACP trick reuses Claude Code/Amp subscriptions. **Model-agnostic:** 15–50+ providers. **Custom tools:** full **MCP** (extensions *are* MCP servers, "70+"). **Subagents:** **first-class** (isolated instances, sequential/parallel, spawned by model or via **recipes**/subrecipes; no nesting). **Worktrees:** requested (#3557) and reportedly implemented ("worktree-aware directory switcher") — version unpinned.
- **`.claude/`:** reads **`AGENTS.md` by default** (+ `.goosehints`); `CLAUDE.md` only via `CONTEXT_FILE_NAMES`; **reads `~/.claude/skills`** (SKILL.md); **Claude subagent-file parsing recently landed** (disc #6202 / PR #6964). Own format = **recipes** (YAML).
- **Fit:** the closest to native `.claude/` ingestion (skills + landing subagents), first-class subagents and MCP, Apache-2.0 — but ChatGPT only via the ACP subprocess proxy, not first-party OAuth. Rust.

## B.5 — OpenHands (formerly OpenDevin)
- **Lang/License:** Python (~65%) + TS / **MIT** (`enterprise/` dir separate). Now [`OpenHands/OpenHands`]; V0 (deprecated Apr 2026, "microagents") vs **V1** (Software Agent SDK, "skills"). Backed by All Hands AI ($18.8M Series A Nov 2025; Graham Neubig). **Windows:** WSL2 + Docker Desktop is the supported path. **Maturity:** ~80k★ (most-starred here).
- **Sub-auth:** **YES** — `LLM.subscription_login()` OAuth PKCE for ChatGPT Plus/Pro (default `gpt-5.2-codex`), cached to `~/.openhands/auth/`. (Anthropic subscription OAuth not yet.) **Model-agnostic:** **LiteLLM** → 100+ providers. **Custom tools:** native **MCP** (`~/.openhands/mcp.json`). **Subagents:** yes (V1 `DelegateTool` parallel ~5 max + `TaskToolSet` sequential; isolated conversations). **Worktrees:** isolation via **Docker container runtime** per session (also K8s, Daytona/E2B/Modal remotes).
- **`.claude/`:** reads **`AGENTS.md`** (always-on repo context) and **`CLAUDE.md`** (as a model-specific variant) — **but not the `.claude/` dir** (skills/agents/commands). Own skills in `.agents/skills/*.md`.
- **Fit:** strong Codex OAuth + LiteLLM + Docker isolation + delegation, MIT — but reads only the CLAUDE.md *file*, and its Docker-first, WSL-on-Windows model is heavier than a CLI harness.

## B.6 — Cline & Roo Code (VS Code)
**Cline (active):**
- **Lang/License:** TypeScript / **Apache-2.0**; Cline Bot Inc. v4.0.8 (2026-07-11), very active (CLI 2.0, open SDK, JetBrains plugin). **Windows:** native (VS Code extension). **Maturity:** ~64.5k★.
- **Sub-auth:** **YES** — "OpenAI Codex" provider with browser "Sign in with OpenAI" OAuth (shipped 2026-01-22, its first OAuth provider; exposes `gpt-5.2-codex` etc.) + API keys. **Model-agnostic:** BYO-key many providers. **Custom tools:** strong **MCP** + official **MCP Marketplace** (one-click). **Subagents:** yes (`use_subagents` parallel + `new_task` subtasks + Focus Chain; can orchestrate the Claude Code CLI as subagents). **Worktrees:** **yes — `cline --worktree`** + a **Kanban** board running many worktree-isolated agents in parallel.
- **`.claude/`:** reads **`.clinerules/`, `AGENTS.md`, `.cursorrules`, `.windsurfrules`** — **not `CLAUDE.md` or `.claude/`.**
- **Fit:** best combo of first-party Codex OAuth + worktree/Kanban parallelism + MCP, Apache-2.0 — but VS-Code-extension-shaped and reads AGENTS.md, not `.claude/`.

**Roo Code — DEAD.** Cline fork, TypeScript, Apache-2.0, ~24.3k★ final. Had ChatGPT Plus/Pro OAuth, MCP, modes (`.roomodes`), Boomerang/Orchestrator subtasks, `.roo/rules/` + AGENTS.md. **Repo archived / extension shut down 2026-05-15** (final v3.54.0); the farewell tells users to switch to Cline. **Not a viable base.**

## B.7 — Continue — **FROZEN**
- **Lang/License:** TypeScript (~84%) + Kotlin / **Apache-2.0**. VS Code + JetBrains + CLI (`cn`). ~34.8k★. **Windows:** native. **Status:** repo **read-only, final v2.0.0 (~Jun 19 2026)**; Continue Dev acqui-hired (reported by Cursor/Anysphere), hosted service winding down (cloud data deletion Jul 15 2026). Local `config.yaml` still works, no future dev.
- **Sub-auth:** **NO** (API-key only). **Model-agnostic:** yes (`config.yaml`). **Custom tools:** **MCP** (`mcpServers:`), agent-mode only. **Subagents:** none documented. **Worktrees:** none native.
- **`.claude/`:** reads `AGENTS.md`/`AGENT.md` and `CLAUDE.md` as root "Agent Files"→rules. No `.claude/` dir.
- **Fit:** avoid — development halted.

## B.8 — Tools that already run GPT on `.claude/` projects (do you even need to build?)

**(a) Route Claude Code *itself* onto GPT** — keeps 100% native `.claude/` reading (skills, agents, commands, settings, hooks); only the model changes:
- **`claude-code-router` (musistudio)** — local gateway (`127.0.0.1:3456`) translating Anthropic Messages ↔ OpenAI ↔ Gemini; conditional routing, fallback, per-workload model (even routes subagent/background to different models); also fronts Codex. **~35.7k★, TS, active.** *The most complete answer if you accept routing Claude Code.*
- **OpenRouter official Claude Code integration** — no proxy: `ANTHROPIC_BASE_URL=https://openrouter.ai/api`, `ANTHROPIC_AUTH_TOKEN=<key>`. Caveat: OpenRouter itself warns reliable *tool use* is only guaranteed on Anthropic's own models — GPT-backed slots can degrade on complex tool calls.
- **LiteLLM Anthropic passthrough** / AI gateways — same env-var mechanism.
- `y-router` — **archived 2026-01-11** (superseded by OpenRouter's official integration).

**(b) Non-Claude harness reading `.claude/` natively** — partial only: **opencode** (`CLAUDE.md` + `.claude/skills/`), **Goose** (`.claude/skills` + landing subagent files). No tool natively parses `.claude/agents/*.md` and runs them on GPT except via routing (a) or conversion (c).

**(c) Format converters (`.claude/` → Codex/AGENTS.md):**
- **`claude-to-codex` (johnpyp)** — most complete: `CLAUDE.md → AGENTS.md`, `.claude/skills/ → .agents/skills/`, `.claude/commands/ → .agents/skills/`, `.claude/agents/ → .codex/config.toml + .codex/agents/*.toml`. `npx claude-to-codex`. **Early/experimental (~6★, "vibe-coded")** — its immaturity signals the niche is under-served.
- `codex-export` skill (a Claude Code skill emitting Codex `.agents/`); MarkdownMe (instruction-file converter only).

**Standards convergence:** `SKILL.md` is a genuine cross-tool open standard ([agentskills.io](https://agentskills.io/specification), AAIF, ~32 tools) — *skills* are already portable, no custom loader needed. `AGENTS.md` vs `CLAUDE.md` have no auto cross-read (bridge via symlink/import; opencode/Goose are the dual-read exceptions).

---

# PART C — Synthesis

## Comparison table

Scoring: ● = yes/strong, ◐ = partial/indirect/experimental, ○ = no/absent. "Sub-auth" = native ChatGPT-subscription sign-in (◐ = via subprocess/ACP proxy).

| Candidate | Sub-auth | Model-agnostic | Custom tools | Hooks | Subagents | Worktrees | Claude-format | Lang / Windows | License | Maturity |
|---|---|---|---|---|---|---|---|---|---|---|
| **Codex CLI** | ● (native ref) | ○ (OpenAI-only) | ● MCP | ● | ◐ exp | ◐ (desktop only) | ◐ AGENTS+SKILL, no `.claude/` | Rust / native | Apache-2.0 | High, fast |
| **opencode** | ● (verify core/plugin) | ● 75+ | ● JS/TS plugins + MCP | ◐ plugin events | ● | ◐ plugin | ◐ CLAUDE.md + `.claude/skills` | TS/Bun / native | MIT | Very high |
| **Crush** | ○ (declined) | ● | ◐ MCP + Skills | ○ | ○ | ○ | ◐ AGENTS + `.claude/skills` | Go / native | FSL-1.1-MIT | Med-high |
| **Aider** | ○ | ● (LiteLLM) | ○ (no MCP) | ◐ lint/test | ○ | ○ | ○ (manual `--read`) | Python / WSL-ish | Apache-2.0 | High, slowing |
| **Goose** | ◐ ACP proxy | ● | ● MCP | ◐ recipes | ● | ◐ | ● `.claude/skills` + subagents landing | Rust / native | Apache-2.0 | High |
| **OpenHands** | ● (Codex OAuth) | ● (LiteLLM) | ● MCP | ◐ | ● | ● Docker/K8s | ◐ CLAUDE.md file only | Python / WSL+Docker | MIT | Very high |
| **Cline** | ● (Codex OAuth) | ● | ● MCP+Marketplace | ◐ | ● | ● worktree+Kanban | ◐ AGENTS, no `.claude/` | TS / native (VS Code) | Apache-2.0 | High |
| **Roo Code** | ● | ● | ● MCP | ◐ | ● | ○ | ○ | TS / native | Apache-2.0 | **DEAD** (archived) |
| **Continue** | ○ | ● | ● MCP | ○ | ○ | ○ | ◐ AGENTS+CLAUDE.md | TS+Kotlin / native | Apache-2.0 | **FROZEN** |
| **Pi** (`badlogic/pi-mono`, user's base) | ● (direct-backend, working) | ● (multi-provider) | (project-specific) | (project-specific) | (project-specific) | (project-specific) | ○ (the gap to build) | TS / native | (check repo) | Active, small |

*Notes:* Codex "Model-agnostic ○" = OpenAI-only by design. opencode Sub-auth ● carries a native-vs-plugin caveat. Pi row reflects that it already ships **direct-backend Codex subscription auth** (verified via #1828) but does not yet read `.claude/` formats.

## Shortlist — 2-3 best bases and tradeoffs

**1. Extend "Pi" (`badlogic/pi-mono`) — recommended if the priority is Codex-subscription control.**
Pi already has the hardest, most fragile piece working: **direct-backend ChatGPT-subscription auth** (`chatgpt.com/backend-api/codex/responses` with the correct `originator: codex_cli_rs`/UA/account-id headers — #1828), and OpenAI's DevEx lead **named Pi explicitly** as a blessed harness. TypeScript, native Windows. The remaining work is exactly the under-served niche: **ingest the full `.claude/` set** (`agents/` subagents, `commands/`, `settings.json`, hooks) — none of which any competitor does either. Tradeoff: smaller project, so you own more of the harness surface (tool loop, sandbox, subagent runtime); the direct-backend path is gray-area and must track Codex header/originator changes.

**2. Fork/adapt opencode — recommended if the priority is a mature, batteries-included base.**
It already does the two hardest things together — **Codex OAuth + reads `CLAUDE.md`/`.claude/skills`** — *and* brings subagents, MCP, a clean JS/TS plugin API, worktree context, and a huge community. MIT, TS/Bun, native Windows. You'd add `.claude/agents/` + `commands/` + `settings.json`/hooks ingestion (modeled on its existing subagent/skill loaders). Tradeoffs: verify whether Codex auth is core or a plugin in the commit you fork; very fast-moving upstream to track; you inherit its opinions.

**3. Don't build a harness — route Claude Code onto GPT (`claude-code-router`), if the goal is purely "my `.claude/` project, GPT model."**
Claude Code stays the harness, so **every** `.claude/` format (skills, agents, commands, settings, hooks) works natively for free; only the model swaps. Mature (~35.7k★). Tradeoffs: you don't control the harness; GPT tool-calling through the Anthropic Messages protocol is less reliable than Claude's (OpenRouter's own caveat); and pointing Claude Code at GPT via API keys is per-token billing unless you additionally wire the router to a Codex-subscription backend shim.

**Honorable mentions:** **Cline** (best first-party Codex OAuth + worktree/Kanban parallelism, but VS-Code-shaped, reads AGENTS.md not `.claude/`), **Goose** (best `.claude/skills` + landing subagent-file support, but ChatGPT only via ACP subprocess), **OpenHands** (Codex OAuth + Docker isolation, but heavy and reads only the CLAUDE.md file). **Avoid** Roo Code (dead) and Continue (frozen).

**Bottom line:** The realistic supported way to spend a ChatGPT subscription is to drive a signed-in `codex` subprocess (`codex mcp-server`/`exec`/SDK); the higher-control way is the direct-backend call Pi already implements (gray-area, edge-fragile). No existing tool ingests the *full* `.claude/` set on a GPT subscription — that gap is the reason to build, and **Pi is the best-positioned starting point** because it has already solved the auth problem that everyone else avoids or proxies.

---

## Sources

**OpenAI Codex — official / source-of-truth**
- Repo (Rust, Apache-2.0): https://github.com/openai/codex — `codex-rs/login/src/` (server.rs, pkce.rs, auth/manager.rs, auth/storage.rs, token_data.rs), `codex-rs/docs/codex_mcp_interface.md`
- Docs (canonical): https://learn.chatgpt.com/docs/auth · /docs/models · /docs/pricing · /docs/config-file/config-reference · /docs/config-file/config-sample · /docs/agent-configuration/agents-md · /docs/agent-configuration/subagents.md · /docs/hooks · /docs/extend/mcp · /docs/non-interactive-mode · /docs/codex-sdk · /docs/windows/windows-sandbox
- Mirrors: https://developers.openai.com/codex/config-reference · /codex/skills · /codex/subagents · /codex/hooks · /codex/mcp · /codex/concepts/sandboxing · /codex/windows · /codex/cloud · /codex/app/worktrees
- Blog: https://openai.com/index/introducing-codex/ · /introducing-upgrades-to-codex/ · /index/building-codex-windows-sandbox/
- Help: https://help.openai.com/en/articles/11369540 · /articles/20001106
- Policy: https://openai.com/policies/row-terms-of-use/ · /usage-policies/
- Discussions/issues: #8338 (fork/ToS) · #8759 (global AGENTS.md) · PR #18035 · #14161 (subagent skills) · #4005 (notify) · #3441/#13025 (project MCP)
- Skills catalogue: https://github.com/openai/skills

**Auth / third-party reuse**
- https://simonwillison.net/2026/Apr/23/gpt-5-5/ (endpoint + Huet + Steinberger quotes — *verified*)
- https://github.com/badlogic/pi-mono/issues/1828 (originator whitelist / 403 — *verified; user's own project*)
- https://docs.litellm.ai/docs/providers/chatgpt · https://github.com/numman-ali/opencode-openai-codex-auth · https://github.com/tumf/opencode-openai-device-auth · https://github.com/7shi/codex-oauth · https://github.com/Soju06/codex-lb (pooling — ToS-violating) · https://github.com/sheikhuzairhussain/codex-cursor-proxy · https://github.com/Securiteru/codex-openai-proxy
- Anthropic precedent: https://openclaw.report/ecosystem/anthropic-bans-oauth-tokens-third-party-tools

**Standards**
- AGENTS.md: https://agents.md/ · SKILL.md: https://agentskills.io/specification · https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview · https://github.com/anthropics/skills

**Alternative harnesses**
- opencode: https://github.com/anomalyco/opencode · https://opencode.ai/docs/rules/ (*verified `.claude/` reading*) · /providers/ · /agents/ · /skills/ · /plugins/ · /mcp-servers/
- Crush: https://github.com/charmbracelet/crush · PR #1783 · issues #2023, #431, #578, #1807
- Aider: https://github.com/Aider-AI/aider · https://aider.chat/docs/llms.html · /docs/usage/modes.html · /docs/usage/conventions.html
- Goose: https://github.com/block/goose · https://goose-docs.ai/docs/getting-started/providers/ · /docs/guides/acp-providers/ · /docs/guides/context-engineering/subagents/ · /docs/guides/context-engineering/using-goosehints/ · disc #6202 / PR #6964 · issue #3557
- OpenHands: https://github.com/OpenHands/OpenHands · https://docs.openhands.dev/sdk/guides/llm-subscriptions · /sdk/guides/agent-delegation · /sdk/guides/skill · /openhands/usage/architecture/runtime
- Cline: https://github.com/cline/cline · https://cline.bot/blog/introducing-openai-codex-oauth · https://docs.cline.bot/customization/cline-rules · https://cline.bot/cli
- Roo Code (archived): https://github.com/RooCodeInc/Roo-Code
- Continue (frozen): https://github.com/continuedev/continue · https://docs.continue.dev/

**Run-GPT-on-.claude tooling**
- claude-code-router: https://github.com/musistudio/claude-code-router
- OpenRouter Claude Code: https://openrouter.ai/docs/cookbook/coding-agents/claude-code-integration
- y-router (archived): https://github.com/luohy15/y-router
- claude-to-codex: https://github.com/johnpyp/claude-to-codex · codex-export: https://mcpmarket.com/tools/skills/codex-export

*Confidence notes: GPT-5.5/5.6 "Sol/Terra/Luna" model names and rate-limit integers post-date the Jan-2026 cutoff and are fast-moving (corroborated by multiple 2026 sources; verify at learn.chatgpt.com/docs/models). `openai.com/policies/*` verbatim quotes were extracted via proxy (pages 403 automated fetch) — confirm in a browser. The Romain Huet endorsement is a tweet, not written policy. opencode Codex-auth native-vs-plugin status and several star counts are order-of-magnitude — verify against the exact fork/date.*

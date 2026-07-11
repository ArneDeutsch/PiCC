# 04 — The "Pi" Harness: Identification, Architecture & Suitability

> Research target: identify the open-source "Pi" coding-agent harness the user mentioned,
> deep-dive its architecture and extension model, and rate its suitability as the base for a
> **new harness that runs GPT/Codex models against Claude-Code-format projects**
> (`.claude/skills`, `.claude/agents`, hooks, `settings.json` permissions, Task + worktree tools).
>
> Date: 2026-07-11. All claims are cited inline; see §8 for the source list.

---

## 1. What "Pi" is (identification + evidence)

**Confidence: HIGH.** "Pi" is unambiguously **Pi, the coding-agent harness by Mario Zechner
(GitHub handle `badlogic`), co-developed with Armin Ronacher** (author of Flask/Jinja2). It is a
minimal, extensible, terminal-first AI coding agent published as an MIT-licensed TypeScript
monorepo.

| Attribute | Value |
|---|---|
| Canonical repo | **https://github.com/earendil-works/pi** (formerly / mirrored as `badlogic/pi-mono`) |
| Org | Earendil Works (https://github.com/earendil-works) |
| Language | **TypeScript / Node.js** |
| License | **MIT** |
| npm (CLI) | `@earendil-works/pi-coding-agent` (also historically `@mariozechner/pi-coding-agent`) |
| Latest version (obs.) | ~v0.80.x, July 2026 — actively released |
| Popularity | Tens of thousands of GitHub stars (sources report ~46k–70k; treat exact number as approximate, but it is a high-visibility project) |
| Docs | https://pi.dev/docs/ and `packages/coding-agent/docs/` in-repo |
| Origin story | Zechner wrote it after heavy Claude Code use, wanting a minimal harness he controlled instead of one that "changes prompts and tools on every release." ([mariozechner.at](https://mariozechner.at/posts/2025-11-30-pi-coding-agent/)) |

### Disambiguation (other "pi"s ruled out)
- **NOT** Inflection's "Pi" chatbot, Prime Intellect, Parallel, or a Rust/Python agent. Those do
  not match "harness / EnterWorktree / skills / subagents" context.
- The user's cues — *minimal, adaptable base; runs GPT/Codex; alongside Claude Code; skills &
  subagents & worktree* — map precisely onto this project. Multiple independent write-ups describe
  it as **"the only Claude Code competitor"** and a **"coding agent harness you can reshape."**
  ([agenticengineer.com](https://agenticengineer.com/the-only-claude-code-competitor),
  [silenceper.com](https://silenceper.com/en/article/2026-05-27-pi-coding-agent-harness/))

> ⚠️ **One caveat on the user's cues:** the tools `EnterWorktree`/`ExitWorktree` are **Claude Code**
> tools, not Pi's. Some AI-generated aggregator pages incorrectly attribute them to Pi. Pi has
> **no built-in worktree tool** (see §5). This is a point where secondary sources hallucinate;
> the primary docs are authoritative.

---

## 2. Architecture

Pi is a **layered monorepo** — you can adopt any layer and replace the rest. This is the single
most important fact for our "build a new harness" goal.

**Packages** ([repo](https://github.com/earendil-works/pi)):
- **`@earendil-works/pi-ai`** — unified multi-provider LLM API. Abstracts **four foundational
  wire protocols**: OpenAI Completions, **OpenAI Responses**, Anthropic Messages, Google
  Generative AI. Implements *cross-provider context handoff* (e.g. Anthropic thinking traces →
  `<thinking>` tags for OpenAI), token/cost tracking, and mid-session model switching.
- **`@earendil-works/pi-agent-core`** — the agent runtime: the loop, tool calling, state
  management, and an **event stream** the UI/extensions subscribe to.
- **`@earendil-works/pi-tui`** — retained-mode terminal UI with differential rendering.
- **`@earendil-works/pi-coding-agent`** — the CLI that wires it all together.

**Agent loop:** prompt → model emits tool calls → runtime executes tools → results fed back →
repeat until done. The loop emits events (`agent_start`, `turn_start`, `tool_call`, `tool_result`,
`agent_end`, …) and supports message queuing between turns.
([mariozechner.at](https://mariozechner.at/posts/2025-11-30-pi-coding-agent/))

**Built-in tools (deliberately minimal):** `read`, `write`, `edit`, `bash`, plus `grep`, `find`,
`ls`. CLI flags `--tools`, `--exclude-tools`, `--no-builtin-tools` control the set. The design
thesis: "these four tools are all you need." **System prompt is <1,000 tokens** vs ~7–10k for
Claude Code/Cline/OpenCode — very little hidden behavior to fight.

**Config file discovery** (highly relevant to us):
- Global: `~/.pi/agent/settings.json`, `~/.pi/agent/AGENTS.md`, `keybindings.json`,
  `models.json`, `trust.json`.
- Project: `.pi/settings.json`, `.pi/AGENTS.md`, `.pi/extensions/`, `.pi/skills/`.
- **Context files: Pi walks the directory hierarchy loading `AGENTS.md` *or* `CLAUDE.md`.**
  So it *already reads Claude Code's `CLAUDE.md`* out of the box. `--no-context-files` disables.
- Project **trust** model (`trust.json`, `defaultProjectTrust: ask|always|never`) gates loading
  of project-local extensions/skills — a lightweight permission concept (not the same as Claude's
  `settings.json` permission rules; see §7).

**Operating modes** (matters for building our own front-end):
- **Interactive** (TUI, default)
- **Print** (`-p`/`--print`) — one-shot, reads stdin
- **JSON** (`--mode json`) — LF-delimited JSON event stream
- **RPC** (`--mode rpc`) — JSONL stdin/stdout protocol for non-Node integrations
- **SDK** — programmatic Node embedding via `createAgentSession()` / `AgentSessionRuntime`,
  `SessionManager`, `ModelRegistry`, `AuthStorage`.

---

## 3. Extension / plugin model

This is Pi's strongest asset for us. Extensions are **TypeScript modules** auto-discovered from
`~/.pi/agent/extensions/*.ts` (global) and `.pi/extensions/*.ts` (project, trust-gated), or added
via `settings.json` `"extensions"` array; hot-reload with `/reload`; test with `pi -e ./path.ts`.
([extensions.md](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md))

**Shape:**
```ts
export default function (pi: ExtensionAPI) {
  pi.registerTool({ /* LLM-callable tool */ });
  pi.registerCommand("stats", { /* slash command */ });
  pi.on("tool_call", async (event, ctx) => { /* hook */ });
}
```

**`ExtensionAPI` (selected):**
- Tools: `registerTool(def)`, `getActiveTools()`, `setActiveTools(names)`, `getAllTools()`
- Commands/UI: `registerCommand()`, `registerShortcut()`, `registerFlag()`,
  `registerEntryRenderer()`
- Messaging/state: `sendMessage()`, `sendUserMessage()`, `appendEntry()`
- Session/model: `setModel()`, `setSessionName()`, `getThinkingLevel()/setThinkingLevel()`
- **Providers: `registerProvider(name, config)` / `unregisterProvider()`** ← lets us add/override
  model backends
- Utilities: `exec()`, shared `pi.events` bus

**Tool definition** uses **TypeBox** schemas (`Type` from `typebox`, `StringEnum` from
`@earendil-works/pi-ai`) and an `execute(toolCallId, params, signal, onUpdate, ctx)` function with
`content` / `details` / optional `terminate`. Tools also provide `renderCall`/`renderResult` for
TUI. This is a clean, typed custom-tool API — exactly what we need to add Claude-equivalent tools.

**Hooks = lifecycle events** (this is Pi's "hook system"; there is no separate shell-hook config
like Claude's `settings.json` hooks, but the event surface is richer and in-process):
- Agent loop: `before_agent_start` (**can inject messages and modify the system prompt**),
  `agent_start/end/settled`, `turn_start/end`
- Tools: **`tool_call` (can BLOCK dangerous tools; input is mutable)**, `tool_result` (can rewrite
  output before the LLM sees it), `tool_execution_start/update/end`
- Input: `input` (transform user prompt before skill expansion)
- Provider hooks: `before_provider_headers`, `before_provider_request`, `after_provider_response`
- Session: `session_start/shutdown/info_changed`

**MCP:** *Not supported by design* — Zechner argues MCP servers inflate context; he prefers CLI
tools + README. (We can still add MCP ourselves via an extension if needed.)

**Slash commands** also exist as markdown templates with arguments (prompt templates), separate
from extension-registered commands.

---

## 4. Model auth & OpenAI / subscription support

**This is where Pi shines for the stated goal.** Pi is provider-agnostic and BYOK by design, and —
critically — supports **subscription OAuth, not just API keys**:

- **`/login` OAuth subscription logins:** **ChatGPT Plus/Pro (Codex subscription)**, Claude
  Pro/Max, and GitHub Copilot. For ChatGPT/Codex the flow is browser + localhost callback, and a
  **device-code login** method has been added
  ([issue #3424](https://github.com/earendil-works/pi/issues/3424)). ⇒ **A user can drive GPT/Codex
  models from their ChatGPT subscription — exactly your requirement.**
- **API keys** for 30+ providers via env vars (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`,
  `GEMINI_API_KEY`, `XAI_API_KEY`, `GROQ_API_KEY`, …).
- **Custom providers** via `~/.pi/agent/models.json` for anything speaking OpenAI/Anthropic/Google
  APIs, or programmatically via `pi.registerProvider()`.
- Model/runtime are decoupled: a **model ref** like `openai/gpt-5.5` selects the model; a **runtime
  id** like `codex` selects the loop executing the turn. Pi can default to an `openai-codex` /
  `gpt-5.5` configuration. Mid-session model switching (`/model`, `setModel()`) is supported.

Net: **no work needed to run GPT/Codex on a subscription** — it is a first-class, shipped feature.

---

## 5. Subagent & worktree support

**Subagents — not built in, but a solved problem via extensions.**
- Core philosophy: **"No sub-agents"** — Zechner deliberately omits them to avoid a "black box
  within a black box," recommending recursive `pi` invocation via `bash` for full observability.
- **But mature community extensions add Claude-Code-style subagents:**
  - **`tintinweb/pi-subagents`** — an **`Agent` tool** (Task-equivalent) accepting
    `prompt`, `subagent_type`, `model`, `thinking`, `run_in_background`; plus `get_subagent_result`
    and `steer_subagent`. Parallel execution with a **concurrency queue (default 4)**, foreground
    (blocking) vs background agents, lifecycle events (`subagents:created/started/completed/…`),
    and **custom agent types defined as `.md` files with YAML frontmatter** (tools, model,
    thinking, max turns, system-prompt body) discovered from `.pi/agents/<name>.md`,
    `.agents/agents/<name>.md`, `~/.pi/agent/agents/`.
    ⚠️ It uses **Pi's own agent `.md` format, not `.claude/agents/`** — a converter/loader would be
    needed to consume Claude subagent files directly.
  - **`teelicht/pi-superagents`** — subagent "superpowers" workflows.
  - **`can1357/oh-my-pi`** — subagents + LSP + Python + browser tooling.

  ⇒ Recursive subagents are **feasible today**; adapting them to read `.claude/agents/*.md` is a
  modest extension task.

**Worktree / session isolation — NOT built in.**
- Pi has **no `EnterWorktree`/`ExitWorktree` equivalent**. It offers only *session* branching
  (`/tree`, `ctx.fork(entryId)`), which forks the conversation, not the git working tree.
- The `EnterWorktree` attribution to Pi seen in some search results is **incorrect** (those are
  Claude Code tools).
- **However**, worktree isolation is straightforward to add ourselves: an extension can
  `registerTool("EnterWorktree")` whose `execute` runs `git worktree add …` via `pi.exec()`/bash,
  swaps `ctx.cwd`, and an `ExitWorktree` that commits + removes. The `subagents` extensions already
  demonstrate "isolated session" patterns to build on.

---

## 6. Setup on Windows 11

**Install (either):**
```bash
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
# or
curl -fsSL https://pi.dev/install.sh | sh   # (Unix-style; on Windows prefer npm)
```
- `--ignore-scripts` is recommended by the project (skips dependency lifecycle scripts).
- Requires **Node.js** (modern LTS) + npm. No Node version is pinned in docs; use current LTS.

**First run:**
```bash
pi                       # interactive TUI
/login                   # pick "ChatGPT Plus/Pro (Codex Subscription)" (or Claude/Copilot)
/model                   # select e.g. openai/gpt-5.5
pi -p "explain this repo"  # one-shot print mode
pi --mode json ...         # event stream for programmatic use
pi -e ./my-ext.ts          # load an extension for testing
```

**Config locations:** `~/.pi/agent/…` (global) and `.pi/…` (project). Env overrides:
`PI_CODING_AGENT_DIR` (config dir), `PI_OFFLINE=1` (no network).

**Windows notes / gotchas:**
- Repo ships **Windows test scripts (`pi-test.bat`, `pi-test.ps1`)** → Windows is a supported/tested
  target. Pure Node.js, so the CLI itself runs on Windows 11.
- **Biggest gotcha: the `bash` tool.** Pi's core tool executes shell commands; on Windows this
  needs a real `bash` (Git Bash / WSL) on PATH, or commands assuming POSIX semantics will fail.
  For a solo dev on Windows, **WSL2 or Git Bash is strongly recommended** for the agent's shell
  tool even though the CLI runs natively. (Your own project here already uses Git Bash + PowerShell,
  so this is a non-issue for you.)
- Extensions are `.ts` executed with full system permissions — same on Windows; only load trusted
  extensions.

---

## 7. Suitability rating + verdict

Scale 1 (poor) – 5 (excellent), against the goal of *a new harness running GPT/Codex on
Claude-Code-format projects*.

| # | Requirement | Score | Justification |
|---|---|:---:|---|
| 1 | Model-agnostic + OpenAI support | **5** | `pi-ai` natively speaks OpenAI Completions **and Responses**, plus Anthropic/Google; 30+ providers; model/runtime decoupled; `codex` runtime + `gpt-5.5`. |
| 2 | Subscription auth (ChatGPT/Codex) | **5** | Shipped `/login` OAuth for **ChatGPT Plus/Pro (Codex)**, incl. device-code. Zero build effort. |
| 3 | Custom-tool extensibility | **5** | First-class typed `registerTool()` (TypeBox), hot-reload, render hooks. Ideal for Task/EnterWorktree tools. |
| 4 | Hook system | **4** | Rich in-process lifecycle events incl. `tool_call` blocking, `before_agent_start` prompt injection, provider hooks. Not shell-hooks like Claude's `settings.json`, but a superset in code; emulating Claude's hook *config* is a small mapping layer. |
| 5 | Subagent / recursion | **4** | Not core, but robust extensions (`pi-subagents`) provide a Task-equivalent `Agent` tool with parallelism/steering. We'd adapt one, or write our own atop the SDK. |
| 6 | Worktree isolation | **3** | None built in; must be added as an extension (git worktree via `bash`/`exec`). Clearly feasible, but net-new work. |
| 7 | Parse Claude `.claude/` formats | **3.5** | **Reads `CLAUDE.md` already**; **skills already use the `SKILL.md` + frontmatter Agent Skills standard and Pi can load Claude Code/Codex skill dirs via settings**. But `.claude/agents/*.md` and `settings.json` **permissions** are Pi-format/absent — need small loaders/mappers. Skills are ~free; agents+permissions are modest work. |
| 8 | Language/ecosystem fit (solo dev, Windows) | **4** | TypeScript/Node — mainstream, easy to extend, runs on Win11. Minor `bash`-tool caveat (use Git Bash/WSL). |
| 9 | License | **5** | **MIT** — permissive, safe to fork/adapt/redistribute. |
| 10 | Maturity / maintenance | **4.5** | Very active (frequent releases to ~v0.80), reputable maintainers (Zechner + Ronacher), large community + third-party extension ecosystem. Pre-1.0 ⇒ some API churn risk. |

**Weighted verdict: Pi is an excellent, arguably ideal, base for this project — recommended.**
The three hardest requirements (OpenAI/Codex models, ChatGPT-subscription auth, typed custom tools)
are **already solved and shipped**. The gaps are all *additive extension work in the exact API Pi
gives us*:
1. A **loader that maps `.claude/skills/*/SKILL.md`** into Pi's skill discovery (nearly free — same
   format/standard).
2. A **subagent extension reading `.claude/agents/*.md`** → Pi agent format (adapt `pi-subagents`).
3. **`EnterWorktree`/`ExitWorktree` tools** via `registerTool` + git worktree.
4. A **`settings.json` permission mapper** feeding the `tool_call` blocking hook (Pi has no native
   allow/deny permission engine — this is the piece with least existing support).

Pi's minimalism (<1k-token system prompt, no hidden behavior, MIT, layered SDK) is precisely what
makes it *adaptable* rather than something to fight — a much better base than forking Claude Code or
Codex CLI themselves.

**Honest risks / where to challenge the choice:**
- Pre-1.0 API churn — extensions may need maintenance across Pi releases.
- No native permission model — Claude `settings.json` allow/deny must be reimplemented on the
  `tool_call` hook.
- Worktree + Claude-agent parsing are genuinely net-new (though small).
- The `bash` tool on bare Windows needs Git Bash/WSL.
- None of these are blockers; collectively they are days, not weeks, of work.

---

## 8. Sources

Primary (authoritative):
- Repo: https://github.com/earendil-works/pi
- Coding-agent README: https://github.com/earendil-works/pi/blob/main/packages/coding-agent/README.md
- Extensions docs: https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md
- Skills docs: `packages/coding-agent/docs/skills.md` (repo)
- Providers docs: https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/providers.md
- pi-ai README: https://github.com/earendil-works/pi/blob/main/packages/ai/README.md
- ChatGPT device-code login issue: https://github.com/earendil-works/pi/issues/3424
- Official docs site: https://pi.dev/docs/
- Author's design essay (Mario Zechner): https://mariozechner.at/posts/2025-11-30-pi-coding-agent/

Ecosystem / subagent extensions:
- Task-equivalent subagents: https://github.com/tintinweb/pi-subagents
- Superagents: https://github.com/teelicht/pi-superagents
- oh-my-pi (subagents/LSP/browser): https://github.com/can1357/oh-my-pi

Secondary (context / reviews — some AI-generated, cross-check before quoting):
- https://www.llmreference.com/agents/pi
- https://agenticengineer.com/the-only-claude-code-competitor
- https://silenceper.com/en/article/2026-05-27-pi-coding-agent-harness/
- https://www.xda-developers.com/replaced-claude-code-and-opencode-with-pi/
- https://github.com/bradAGI/awesome-cli-coding-agents
- https://dev.to/arshtechpro/pi-the-open-source-ai-coding-agent-you-probably-havent-tried-yet-2h0h

> Note on reliability: exact star counts and some "EnterWorktree/worktree" and "default Codex
> model" claims appear only in AI-generated aggregator pages and conflict with the primary docs.
> Where they conflict, this document follows the repo/official docs and flags the discrepancy.

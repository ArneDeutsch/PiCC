# 06 — Gap Analysis, Harness Recommendation & Development Plan

> Synthesis of docs 01–05 into a decision-ready picture: which harness to build on,
> how to spend a ChatGPT/Codex subscription, exactly which Claude Code features the
> reference project (DemonMatrix) needs, how big each gap is on the recommended base
> (Pi), a phased build plan, and the open questions to resolve before coding.
>
> Date: 2026-07-11. Read alongside `01`–`05`; this doc does not restate their detail.

---

## 1. Executive recommendation

**Build PiCC as a set of extensions on top of Pi (`earendil-works/pi`, MIT, TypeScript).**

The three hardest problems for "run GPT/Codex on my ChatGPT subscription" are **already
solved and shipped in Pi**:

1. **ChatGPT/Codex subscription auth** — Pi does the gray-area-but-working *direct-backend*
   call to `chatgpt.com/backend-api/codex/responses` with the required `originator: codex_cli_rs`
   header. This is the single most fragile piece and it is done (verified via `badlogic/pi-mono`
   issue #1828, which is Pi's own originator-403 fix — see `05 §A.5`).
2. **Multi-provider model abstraction** — `pi-ai` natively speaks OpenAI Completions **and**
   Responses, plus Anthropic/Google; model/runtime decoupled; mid-session model switching.
3. **Typed, hot-reloadable custom tools + in-process lifecycle hooks** — `registerTool()` (TypeBox)
   and a `tool_call` hook that can *block* a call, `before_agent_start` that can *modify the system
   prompt*. This is a superset of what we need to emulate Claude's tool + hook surface (`04 §3`).

Everything the DemonMatrix corpus additionally needs — Claude `.claude/skills` and `.claude/agents`
loaders, a `Task`/`Agent`-equivalent subagent runtime, `EnterWorktree`/`ExitWorktree`, a
`settings.json` permission engine, and a `PreToolUse`/`PostToolUse` shell-hook shim — is **additive
extension work in Pi's own API**. It is days-to-a-few-weeks of work, not a rewrite. See the matrix
in §4 and the plan in §6.

Two credible alternatives, and why they lose to Pi for *this* goal, are in §3.

> **Naming note / possible correction.** Doc `05` states "Pi is your own `badlogic/pi-mono`." That
> is very likely a misread: Pi is **Mario Zechner's** project (`earendil-works/pi`, mirror
> `badlogic/pi-mono`); issue #1828 lives in *that* repo, not necessarily a fork you own. It does not
> change the recommendation — it strengthens it (the auth work is upstream and maintained) — but
> confirm whether you intend to **fork** Pi or **depend on it + ship extensions**. This is Open
> Question Q1 (§7). The project name "PiCC" (Pi + Claude + Codex) reads as a deliberate choice
> to build on Pi.

---

## 2. The subscription-auth decision (resolve early — it shapes everything)

A ChatGPT subscription entitles the **Codex product surface**, a *separate billing system* from the
per-token Responses API on `api.openai.com`. You cannot spend a subscription through the public API.
There are exactly two ways to spend it (`05 §A.5`):

| Mode | What it is | Pros | Cons | Status |
|---|---|---|---|---|
| **(A) Direct-backend** *(what Pi does)* | Read `~/.codex/auth.json`, call `chatgpt.com/backend-api/codex/responses` with `originator: codex_cli_rs` + versioned UA + `ChatGPT-Account-Id` | Full control of the loop, tools, context; native to Pi | Undocumented endpoint; gray-area ToS; must track originator/UA changes; edge-fragile (403/Cloudflare) | **Working in Pi today** |
| **(B) Subprocess** | Drive the user's signed-in `codex` as a child process (`codex mcp-server`, `codex exec --json`, or `@openai/codex-sdk`) | Officially supported; no ToS risk; inherits `auth.json` | You inherit Codex's tool loop + sandbox; less control; harder to graft our worktree/subagent semantics on | Supported by OpenAI |

**Recommendation: default to (A) via Pi**, because the whole point of PiCC is fine control over
tools/worktrees/subagents that mode (B) would take away. Keep (B) in mind as a fallback if OpenAI
tightens edge enforcement or bans personal third-party OAuth reuse (Anthropic set that precedent in
Apr 2026; OpenAI had not, as of mid-2026 — `05 §A.5`). **Personal single-account use is tolerated and
verbally endorsed** (OpenAI DevEx lead named Pi explicitly); **account pooling / credential sharing is
a clear ToS violation** — stay single-account.

This is Open Question Q2 (§7).

---

## 3. Why Pi over the two real alternatives

| Option | The pitch | Why it loses for this goal |
|---|---|---|
| **Fork opencode** (`05 §B.1`) | Most batteries-included: already does **Codex OAuth + reads `CLAUDE.md` + `.claude/skills`**, plus subagents, MCP, JS/TS plugin API, MIT | Still misses `.claude/agents`, `.claude/commands`, `settings.json`, hooks (same gap as Pi). You inherit a large, fast-moving, opinionated codebase and a ~7–10k-token system prompt to fight. Pi's minimalism (<1k-token prompt, "no hidden behavior") makes it a better *reshapeable* base. Keep opencode as the **fallback base** if Pi's pre-1.0 churn or small surface becomes painful. |
| **Don't build — route Claude Code onto GPT** via `claude-code-router` (`05 §B.8a`) | Claude Code stays the harness, so **100 %** of `.claude/` (skills/agents/commands/settings/hooks) works natively; only the model swaps | (1) Claude Code's **subagents are hard-locked to Claude models** — your GPT subscription would *not* drive the fan-out subagents, which is the heart of the DemonMatrix workflow. (2) Routing to GPT via API keys is **per-token billing**, not your subscription, unless you additionally build a Codex-subscription backend shim. (3) You don't control the harness — no room for the custom worktree/dispatch semantics you want. Good **stopgap** to run a `.claude/` project on GPT *today*, not a fit for the stated vision. |

**Net:** Pi is the best *adaptable* base; opencode is the best *fallback*; routing Claude Code is the
best *zero-build stopgap*. The rest of this doc assumes Pi.

---

## 4. Requirements → capability matrix (DemonMatrix needs vs Pi)

Every capability the DemonMatrix corpus relies on (from `01`'s checklist), scored against Pi
(from `04`) with the concrete gap and a rough effort. **Effort key:** S = ≤1 day, M = 2–4 days,
L = ~1 week+. "Pi status": ✅ shipped · 🟡 partial/adaptable · ❌ absent.

### 4.1 Skills & slash commands

| Capability (DemonMatrix relies on) | Pi status | Gap → work | Effort |
|---|:--:|---|:--:|
| Discover `.claude/skills/<name>/SKILL.md`, parse frontmatter (`name`, `description`, `user-invocable`, `argument-hint`, `metadata.portability`) | 🟡 | Pi has its own skills dir + the `SKILL.md` open standard; add a **loader that points skill discovery at `.claude/skills/`** (or junctions it in, à la `codex.ps1`) and maps the extra frontmatter keys. Skills are format-compatible (agentskills.io). | S–M |
| Route `user-invocable: true` → slash command; keep `user-invocable: false` referable-by-path | 🟡 | Map `user-invocable` to Pi's command registration; non-invocable skills just remain files the model `read`s. | S |
| `$ARGUMENTS` substitution + `argument-hint` | 🟡 | Pi has arg'd prompt-template commands; wire `$ARGUMENTS`/positional substitution to match Claude semantics (`02 §1.4`). | S |
| Progressive disclosure of bundle files (`prompts.md`, `references/*`, `template-*.md`, `workflow-*.md`) loaded on demand | ✅ | Works for free: the model reads sibling files via the `read` tool relative to the skill dir. Provide a `${SKILL_DIR}`-equivalent. | S |
| Skill instructs model to "read `<other skill>/SKILL.md` in full" (cross-file path reads) | ✅ | Native `read` tool. Just ensure `.claude/**` is readable/allowlisted. | — |

**Note:** DemonMatrix uses **no `allowed-tools` in skill frontmatter** (`01 §1.2`) — tools are gated
by agent `tools:` + `settings.json`. So the skill loader can ignore tool-gating frontmatter entirely.

### 4.2 Subagents & dispatch (the workflow's core)

| Capability | Pi status | Gap → work | Effort |
|---|:--:|---|:--:|
| Register agents from `.claude/agents/*.md`; parse `name`, `description`, `tools`, `color`, `permissionMode`, `metadata` | 🟡 | Community `pi-subagents` uses **Pi's own agent `.md` format** — write a **loader/mapper from `.claude/agents/*.md`** into it. Straightforward (same shape: frontmatter + system-prompt body). | M |
| **Auto-inject every agent's `description` into the orchestrator context** (the routing surface) | 🟡 | Use `before_agent_start` to append the agent-description catalog to the system prompt. This is the **central routing mechanism** — must be faithful. | S–M |
| A `Task`/`Agent`-equivalent tool: spawn a **fresh-context** subagent by `subagent_type:` | 🟡 | Adapt `tintinweb/pi-subagents` `Agent` tool (accepts `prompt`, `subagent_type`, `model`, `run_in_background`). | M |
| **Parallel** fan-out in one orchestrator turn; capture each subagent's **final message verbatim** | 🟡 | `pi-subagents` already has a concurrency queue (default 4) + background/foreground. Ensure the final assistant message is captured verbatim (the locked-YAML return, `01 §6.4`). | S–M |
| Per-agent `tools:` allowlist gates Edit/Write/Bash (read-only reviewers cannot write) | 🟡 | Enforce in the subagent runtime via Pi's `setActiveTools()`/tool filtering per spawned agent. | S |
| `permissionMode: default` honored (only value used) | ✅ | Trivial — only the default gate is needed. | — |
| Recursion depth = 1 (agents never spawn agents) | ✅ | DemonMatrix keeps fan-out **flat** (`01 §6.2`) — no nested-subagent support required. Simplifies the runtime. | — |

**Simplifying facts from `01`:** no nested subagents, no MCP, only `permissionMode: default`. The
subagent runtime can be flat and simple.

### 4.3 Permissions & settings

| Capability | Pi status | Gap → work | Effort |
|---|:--:|---|:--:|
| Parse `settings.json` + `settings.local.json`, merge `permissions.allow` | ❌ | Pi has only a coarse project-`trust` model, **no allow/deny rule engine** (`04 §7`). Build a **permission engine** feeding Pi's `tool_call` blocking hook. This is the piece with the least existing support. | M–L |
| Matcher forms: bare tool; `Bash(<prefix>:*)`; `Bash(<exact>)`; `Bash(<glob>:*)` (e.g. `tools/dm-*.sh`); `WebFetch(domain:*)`; `Read(<pathglob>)` | ❌ | Implement the matcher semantics from `02 §7.2` (shell-operator-aware Bash matching, gitignore-style Read anchors, WebFetch domain rules). DemonMatrix only needs **allow** (no deny/ask observed), which shrinks scope. | M |
| `worktree.baseRef` (`head`) read from settings | ❌ | Read it; feed `EnterWorktree` (§4.4). | S |

**Scope-limiter:** DemonMatrix uses **only `permissions.allow`** and `permissionMode: default` — no
`deny`/`ask`, no exotic modes. Build the allow-matcher first; deny/ask can come later.

### 4.4 Worktrees (EnterWorktree / ExitWorktree)

| Capability | Pi status | Gap → work | Effort |
|---|:--:|---|:--:|
| `EnterWorktree(name:)` creates `.claude/worktrees/<flat>/` on branch `worktree-<name>` off resolved base, writes a base-SHA record, **changes session cwd** | ❌ | Net-new tool via `registerTool` + `git worktree add -b` + `pi.exec`. Full spec in `03 §e.2`. The **cwd change is load-bearing** (drives `dm-preflight.sh`'s `mode=` detection). | M |
| `EnterWorktree(path:)` re-enters an existing worktree, changes cwd, creates nothing | ❌ | Same tool, resume branch. `03 §e.2`. | S |
| `worktree.baseRef: "head"` bases off local HEAD; resolve base **before** `add` | ❌ | `03 §b.4` (mind Claude bug #60588 — resolve explicitly). | S |
| Windows: `worktree remove` best-effort, **reap-later** (never hard-fail a merge); strip reparse points before remove; `core.longpaths` | ❌ | Implement the "best-effort remove + reap orphans" pattern `/merge` expects (`03 §a.6`, §d). | M |
| `ExitWorktree(action:)` present for interactive sessions (DemonMatrix `/merge` exits via raw git, so not on the critical path) | ❌ | Provide it, but `/merge` doesn't need it — lower priority. `03 §e.3`. | S |
| One worktree per container running **concurrently** (parallel sessions on one repo) | 🟡 | Pi runs per-process; parallel sessions = multiple `pi` invocations, each entering its own worktree. `git worktree lock` while active. `03 §b.5`. | S–M |

`.claude/worktrees/` must be **gitignored** so worktree contents don't show as untracked in main.

### 4.5 Hooks & git

| Capability | Pi status | Gap → work | Effort |
|---|:--:|---|:--:|
| `PreToolUse` / `PostToolUse` shell hooks with `matcher` (tool-name regex) + `if:` (payload conditional, e.g. `Bash(git *)`) + `command:` | 🟡 | Pi has *in-process* lifecycle hooks (`tool_call`, etc.) but **not Claude's shell-hook config**. Build a **shim** that reads `settings.json` `hooks` and dispatches shell commands on `tool_call`/`tool_result`, implementing `matcher` + `if:`. | M |
| Deliver tool-call payload to a PreToolUse `command` as **JSON on stdin** (incl. `tool_input.file_path`); Windows doubled-backslashes | 🟡 | Match the stdin payload shape from `02 §3.4`. The worktree-guard parses `tool_input.file_path`. | S |
| Honor a PreToolUse hook's stdout `{"hookSpecificOutput":{"permissionDecision":"allow","additionalContext":"…"}}` — write proceeds **and** `additionalContext` reaches model context (warn-only guard) | 🟡 | Map hook stdout JSON → Pi's `tool_call` result (allow + inject context). `02 §3.5`, `03 §a.7`. | S–M |
| Run the `core.hooksPath` self-heal after git commands (or set `core.hooksPath .githooks` at session start) so `.githooks/pre-commit` fires | 🟡 | Either run the PostToolUse hook faithfully, or just set `core.hooksPath` once on session start. | S |
| `git commit` invokes the repo pre-commit hook (never `--no-verify`) and surfaces its exit code | ✅ | Native git behavior once `core.hooksPath` is set; ensure the `bash` tool doesn't strip the hook. | — |
| The `dm-*.sh` scripts run under `bash` on Windows | ✅ (user env) | Pi's `bash` tool needs Git Bash/WSL on PATH — the user already has Git Bash. `04 §6`. | — |

### 4.6 CLAUDE.md hierarchy

| Capability | Pi status | Gap → work | Effort |
|---|:--:|---|:--:|
| Load root `CLAUDE.md` | ✅ | Pi already walks the tree loading `AGENTS.md` **or** `CLAUDE.md` (`04 §2`). | — |
| **Auto-inject nearest-ancestor `CLAUDE.md`** when the model reads/edits a file in a subdir (root + 9 per-crate files), including inside worktree checkouts | 🟡 | Pi loads context files at start; add **on-demand subdir injection** on file read (Claude's nested behavior, `02 §6.2`). Needed so per-crate `**Role:**`/`**Conformance test:**` blocks reach the model. | M |

### 4.7 Output/return conventions

| Capability | Pi status | Gap → work | Effort |
|---|:--:|---|:--:|
| Treat a subagent's final assistant message as its machine-parseable return (locked YAML); re-invoke-once on malformed return | 🟡 | The subagent runtime must return the **verbatim final message**; the orchestrator (skill prose) parses YAML. Add the one-retry-on-malformed convention if convenient. `01 §6.4`. | S |
| Preserve verbatim reasoning-effort steering from prompt text ("apply maximum reasoning effort") + map to model effort | 🟡 | Optionally map to Pi's `setThinkingLevel()`/model effort; at minimum pass the text through. | S |

### 4.8 Explicitly NOT required (from `01`)

- **MCP servers** — none used anywhere in the corpus.
- **`allowed-tools`** in skill frontmatter — not used.
- **`permissionMode`** values other than `default`.
- **`deny` / `ask`** permission rules — only `allow` observed.
- **Nested (recursive) subagents** — fan-out is flat, depth 1.

These absences meaningfully shrink the build.

---

## 5. Proposed PiCC architecture

A thin **extension bundle** on Pi (one Pi extension, or a small set), plus a compatibility layer:

```
pi (earendil-works/pi)  ──►  runtime: agent loop, pi-ai (Codex subscription auth), bash/read/write/edit
        │
        └── PiCC extension bundle (.ts, registered via settings.json "extensions")
              ├── claude-skills-loader     → point skill discovery at .claude/skills/ (or junction), map frontmatter
              ├── claude-agents-loader     → parse .claude/agents/*.md → subagent registry; inject descriptions
              ├── subagent-runtime         → Agent/Task tool (adapt pi-subagents): fresh ctx, parallel, verbatim return, per-agent tools:
              ├── worktree-tools           → registerTool EnterWorktree / ExitWorktree (git worktree + cwd swap + CLAUDE_BASE + Windows reap)
              ├── permission-engine         → parse settings.json allow-list; enforce on tool_call (matcher semantics)
              ├── hook-shim                 → settings.json hooks (PreToolUse/PostToolUse) → shell dispatch w/ stdin JSON + stdout decision
              ├── claudemd-injector         → nearest-ancestor CLAUDE.md on file read (nested injection)
              └── config: worktree.baseRef, dm-*.sh allowlist, .claude/worktrees gitignore check
```

**Design principles carried from the research:**
- **Faithful primitives, not a workflow port.** DemonMatrix encodes its whole factory as *data*
  (24 skills + 9 agents + `dm-*.sh`). Reproduce the ~10 runtime primitives (`01 §0`) and the corpus
  runs unchanged — do not reimplement the workflow.
- **cwd is load-bearing.** Every worktree/git/preflight behavior depends on the harness changing the
  process cwd on `EnterWorktree` and restoring on exit (`03 §a.5`).
- **Verbatim final message = the return value.** The subagent runtime must not summarize or wrap the
  agent's last message; skills parse the locked YAML directly (`01 §6.4`).
- **Allowlist-friendly commands.** The corpus deliberately routes git/status through single
  `dm-*.sh` invocations so a static allow-matcher (`Bash(tools/dm-*.sh:*)`) covers them — the
  permission engine must support that glob-in-matcher form (`01 §3.1`).

---

## 6. Phased development plan

Ordered so each phase produces something runnable and de-risks the next. Validate every phase against
DemonMatrix (the reference corpus) — ideally a throwaway container/chore.

**Phase 0 — Spike the auth + loop (½–1 day).** Install Pi on Windows (Git Bash on PATH), `/login`
with the ChatGPT/Codex subscription, run a GPT-5.6 turn on a trivial repo. Confirm `CLAUDE.md` is
read. This validates the entire premise (§1) before investing. *(De-risks Q2.)*

**Phase 1 — Skills + CLAUDE.md (2–4 days).** claude-skills-loader + claudemd-injector. Success:
`/status` and a read-only skill run against DemonMatrix; per-crate `CLAUDE.md` injects on file read.

**Phase 2 — Permissions + hook-shim (4–7 days).** permission-engine (allow-only matcher) +
hook-shim (PreToolUse/PostToolUse, `if:`, stdin JSON, stdout decision). Success: the worktree-guard
warns correctly; `core.hooksPath` self-heals; `dm-commit.sh` fires the pre-commit gate.

**Phase 3 — Subagents (4–7 days).** claude-agents-loader + subagent-runtime (Agent tool, parallel
fan-out, per-agent `tools:`, verbatim return, description injection). Success: a review fan-out over
a diff returns locked-YAML from the right description-matched agents.

**Phase 4 — Worktrees (3–6 days).** EnterWorktree/ExitWorktree + baseRef + Windows reap. Success:
`/implement` on `main` isolates into `.claude/worktrees/<flat>/`, `dm-preflight.sh` reports
`mode=worktree`, `/merge` merges + reaps (Windows remove-failure tolerated).

**Phase 5 — End-to-end + parallel (ongoing).** Run a real DemonMatrix container end-to-end
(`/plan-feature` → `/implement` → `/collaborate` → `/merge`); then two containers in parallel
worktrees. Harden Windows path/canonicalization edge cases (`03 §d`). Track Pi upstream churn.

**Rough total to a working single-session flow: ~2–4 weeks solo; parallel + hardening beyond that.**

---

## 7. Open questions / decisions to resolve before/early in coding

- **Q1 — Fork vs depend?** Fork Pi (full control, must track upstream manually) or depend on the
  published `@earendil-works/pi-coding-agent` + ship extensions (cleaner upgrades, exposed to pre-1.0
  API churn)? *Recommendation: depend + extensions first; fork only if you hit a wall.* (`04 §7` risk.)
- **Q2 — Auth mode?** Direct-backend (A, Pi default) vs subprocess (B). *Recommendation: A; keep B as
  fallback.* Validate in Phase 0. (`05 §A.5`, §2 above.)
- **Q3 — Skills: junction vs native loader?** Reuse the `codex.ps1` NTFS-junction trick to mount
  `.claude/skills` into Pi's skill path (fast, zero-code) vs a proper loader that reads `.claude/skills`
  in place (cleaner, cross-platform). *Recommendation: loader; junctions as a Phase-1 stopgap.*
  (`03 §a.10`.)
- **Q4 — Permission strictness?** DemonMatrix needs only `allow` + `default` mode. Ship allow-only
  first; decide later whether to implement `deny`/`ask`/modes for other projects.
- **Q5 — How faithfully to emulate the hook stdin/stdout contract?** Full Claude fidelity (`02 §3`)
  lets *any* `.claude/` project run; a DemonMatrix-only subset is smaller. *Recommendation: implement
  the subset DemonMatrix uses (PreToolUse warn + PostToolUse `if:`), designed to extend.*
- **Q6 — Reasoning-effort mapping.** Does the corpus's prose steering ("apply maximum reasoning
  effort") need to map onto Codex `model_reasoning_effort`, or is pass-through enough? (`05 §A.5` shows
  Codex effort levels Low→Ultra.)

## 8. Research still worth doing before/at build time

1. **Read Pi's actual extension API + skills/agents loaders in the repo** (not just docs) — confirm
   `registerTool`, the `tool_call` hook signature, skill discovery paths, and how `pi-subagents`
   captures a subagent's final message. Pin to a specific Pi version. *(Highest value.)*
2. **Verify the live Codex model names + effort levels + rate limits** (`gpt-5.6 "Sol"`, etc.) at
   `learn.chatgpt.com/docs/models` — these post-date the Jan-2026 cutoff (`05` caveats).
3. **Confirm a few `settings.json` keys** flagged `[community-inferred/unverified]` in `02 §4.2`
   against the live Claude settings page before relying on them (DemonMatrix doesn't use them, so
   low urgency).
4. **Prototype the worktree tool against DemonMatrix's exact plumbing** — the `CLAUDE_BASE` file,
   `worktree-<name>` leftover branch, and the `mode=` detection are precisely specified in `03`;
   validate the tool reproduces them.
5. **Windows hardening list** — reparse-point stripping before `worktree remove`, `cygpath -m`
   canonicalization in the hook shim, `core.longpaths` (`03 §d`).
6. **Decide the DemonMatrix `.codex-home`/`codex.ps1` disposition** — the old scaffolding is
   inadequate (`01` scope note) but shows the junction pattern; decide whether PiCC replaces it
   entirely.

---

## 9. Risk register

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| OpenAI tightens edge enforcement / bans personal 3rd-party OAuth reuse (Anthropic precedent) | Med | High | Keep subprocess mode (B) as fallback; stay single-account; track Codex originator/UA changes |
| Pi pre-1.0 API churn breaks extensions | Med | Med | Pin a Pi version; thin extension surface; fork if needed (Q1) |
| Permission engine + hook shim is subtler than estimated (matcher edge cases) | Med | Med | Implement only the allow-subset DemonMatrix uses; expand later (Q4/Q5) |
| Windows worktree remove / path issues | Med | Low–Med | Adopt DemonMatrix's proven best-effort-remove + reap-later + `cygpath` patterns (`03 §d`) |
| Description-driven agent selection behaves differently on GPT than Claude | Med | Med | Faithful description injection (`04 §3` `before_agent_start`); test the fan-out early (Phase 3) |
| Subagent runtime doesn't return verbatim final message → YAML parsing breaks | Low–Med | High | Make verbatim-return a hard contract of the runtime; add one-retry-on-malformed |

---

## 10. Bottom line

The vision is realistic and the path is concrete: **stand up Pi with Codex-subscription auth (Phase 0),
then add ~7 small extensions** (skills loader, CLAUDE.md injector, permission engine, hook shim,
subagent runtime, worktree tools) that reproduce the ~10 Claude Code primitives DemonMatrix depends on.
The two genuinely hard things — spending a ChatGPT subscription and abstracting the model — are already
done in Pi. The remaining work is well-specified (docs `01`–`03` give exact contracts), bounded by the
fact that DemonMatrix uses **no MCP, no nested subagents, and only `allow`+`default` permissions**, and
sequenced in §6 so each phase is independently testable against the reference corpus.

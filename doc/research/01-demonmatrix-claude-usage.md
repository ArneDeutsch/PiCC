# DemonMatrix — Claude Code Feature Inventory (for a GPT/Codex harness rebuild)

Reference-grade inventory of every Claude Code mechanism the DemonMatrix project relies on, so a new agentic harness can run GPT/Codex models against the same `.claude/` corpus unchanged. All paths are relative to `F:/Arne/Projekte/DemonMatrix/`.

> **Scope note on the OLD Codex scaffolding (ignored, one paragraph).** The repo root carries `codex.ps1`, `.codex-home/config.toml`, and `.agents/` — a first, rough Codex-compat attempt. `codex.ps1` sets `$env:CODEX_HOME` to `.codex-home`, then junctions each `.claude/skills/<dir>` into `.codex-home/skills/<dir>` (plus a junction to the user's `~/.codex/skills/.system`) and launches `codex -C <repo>`. `.codex-home/config.toml` sets `project_doc_fallback_filenames = ["CLAUDE.md"]`, `model = "gpt-5.5"`, `model_reasoning_effort = "high"`, and marks the repo `trusted`. This approach only re-exposes skill *directories* by symlink and points Codex at `CLAUDE.md`; it does **nothing** about the load-bearing mechanisms this document catalogs — subagent dispatch (`Task`/`subagent_type`), the `EnterWorktree` tool, `PreToolUse`/`PostToolUse` hooks, the description-driven agent-selection model, the permission allowlist, or the locked-YAML output contracts. It is therefore not a spec for the new harness and is not treated as one below.

The project is a Rust ARPG (custom engine on wgpu/winit/hecs/kira). The `.claude/` corpus is an unusually elaborate **multi-agent, worktree-parallel, git-native software-factory workflow**. The key insight for a harness rebuild: **the workflow is almost entirely encoded as data (skill markdown + agent markdown + frontmatter + a handful of `tools/dm-*.sh` scripts), driven by a small set of Claude Code runtime primitives.** Reproduce those primitives and the corpus runs.

---

## 0. The runtime primitives the corpus depends on (orientation)

Before the eight detailed sections, the concrete Claude Code capabilities the corpus invokes:

| Primitive | Where used | Must the new harness supply it? |
|---|---|---|
| **Skills** (`.claude/skills/<name>/SKILL.md`, frontmatter + progressive-disclosure files) | 24 skills | Yes — skill discovery, frontmatter parsing, slash-command routing, `$ARGUMENTS` |
| **Subagents / `Task` tool** with `subagent_type: <agent-name>` | every fan-out + author dispatch | Yes — fresh-context sub-invocations, parallel dispatch, bounded return capture |
| **Agents** (`.claude/agents/<name>.md`, frontmatter incl. `tools:`, `description:`) | 9 agents | Yes — agent registry, description auto-injection, per-agent tool gating |
| **`description`-driven selection** (agent descriptions auto-injected into orchestrator context; routing keys off them) | coordinator §2, executor-selection §3a | Yes — this is the central routing mechanism |
| **`EnterWorktree` tool** (`name:` / `path:`) | dispatch-floor §1 | Yes — create/enter a git worktree in-session, main-session only |
| **`settings.json` permissions** (allow matchers) | `.claude/settings.json` + `.local.json` | Yes — a tool-call allowlist with `Bash(...)`, `WebFetch(domain:...)`, `Read(...)` matchers |
| **`hooks`** — `PreToolUse` / `PostToolUse` with `matcher`, `if:`, `command` | `.claude/settings.json` | Yes — deterministic shell hooks around tool calls, PreToolUse stdin JSON payload + stdout `hookSpecificOutput` |
| **Git `core.hooksPath` + `.githooks/pre-commit`** | wired by a PostToolUse hook | Yes (indirect) — the corpus expects a git pre-commit gate to fire on every commit |
| **`CLAUDE.md` hierarchy** (root + per-crate, auto-injected on file reads in that dir) | root + 10 crate/tool files | Yes — directory-scoped context injection |
| **Locked-YAML output contracts** (agent returns exactly one YAML block as its final message) | output-contract skill | Partially — a prompt convention, but the harness must reliably capture "the agent's final message" |
| **`argument-hint`, `user-invocable`, `metadata.portability`** frontmatter keys | skill frontmatter | Yes — parse and honor |
| **MCP** | none found | No — the corpus uses no MCP servers |

---

## 1. Skills

### 1.1 Full skill inventory

24 skill bundles under `.claude/skills/*/SKILL.md`. `user-invocable: true` skills are slash commands the human types; `user-invocable: false` are **internal contract/library skills composed by name into other skills' prompts** (never directly invoked).

| Skill | user-invocable | portability | One-line purpose |
|---|---|---|---|
| `implement` | **true** (`/implement`) | generic-workflow | Build one whole container (feature/chore) end-to-end; router → workflow-spine. |
| `collaborate` | **true** (`/collaborate`) | project-binding | Run one pending *collaborative* (visual/sensory) task in a fresh main-session context via the asset-viewer human-in-the-loop; re-invokes `/implement`. |
| `merge` | **true** (`/merge`) | project-binding | Merge a completed container branch to `main` (`git merge --no-ff`), GPU gate, worktree/branch reap, status rollup. |
| `plan-feature` | **true** (`/plan-feature`) | generic-workflow | Plan a feature collaboratively: direction → gather + critique fan-outs → one `feature.md` + full task specs. |
| `plan-milestone` | **true** (`/plan-milestone`) | generic-workflow | Plan a milestone: direction → status-gather + proposer fan-outs → short WHAT-only plan. |
| `review-milestone` | **true** (`/review-milestone`) | generic-workflow | Close a milestone: semantic review + retrospective + next-planning handoff. |
| `status` | **true** (`/status`) | generic-workflow | Project dashboard; reads `tools/dm-status.sh`, suggests next skill command. |
| `create-mod` | **true** (`/create-mod`) | project-specific | Scaffold a new mod (`mod.yaml`, scope, priority, layout) verified via `--list-mods`. |
| `coordinator` | false | generic-workflow | **The orchestrator contract** — read by main session only, never composed downward. |
| `dispatch-floor` | false | generic-workflow | Shared per-task dispatch substrate (branch/worktree, scheduling, execution-log, thin-dispatcher, escalation, plan-adaptation). |
| `workflow-spine` (file `implement/workflow-spine.md`) | n/a (bundle file) | generic-workflow | The `/implement` task loop + in-loop review tiers. |
| `state-model` | false | project-binding | Single home of the **state grammar** — paths, globs, status tokens, branch/worktree names, `dm-*` contracts. |
| `plan-model` | false | generic-workflow | Single home of planning-altitude contracts — milestone/feature/task altitudes, task-spec format, decomposition method, novelty/spike rule. |
| `output-contract` | false | generic-workflow | Locked-YAML output-format contracts (§1 findings/review, §2 plan-attendance, §3 authoring, §4 role-specific, §5 shared rules + composition footer). |
| `role-common` | false | generic-workflow | Shared agent-facing invariants (commit ownership, diff-required, no-surface fallback, rule-cluster escalation, never-negotiate-inline). |
| `review-craft` | false | generic-workflow | Domain-agnostic review-engagement recipe (read prompt → read diff in full → identify touched set → apply checklist → verify → decide verdict). |
| `execution-craft` | false | generic-workflow | Implementation-task execution activity contract (read spec → implement per logical unit → validate → self-check → return). |
| `form-craft` | false | generic-workflow | Serial post-synthesis form pass over prose (the Author's activity contract). |
| `close-synthesis` | false | generic-workflow | Feature-close review-synthesis activity contract (composed into the fresh process-owner synthesiser). |
| `retrospective-synthesis` | false | generic-workflow | Milestone retrospective-synthesis activity contract. |
| `feature-close` | false | generic-workflow | Auto-issued feature close: semantic review fan-out + Level-5 human gate + synthesis + Author pass + status handoff at IN_REVIEW. |
| `task-prompts` | false | generic-workflow | The two per-task invocation-prompt templates (§1 author dispatch, §2 review). |
| `asset-viewer` | false | project-specific | The asset-viewer human-in-the-loop design session (mode picker, spec grammars, launch, round discipline, transfer). |

### 1.2 SKILL.md frontmatter schema (every distinct key observed)

Across all 24 skills, the complete set of frontmatter keys:

- `name:` — skill id (matches directory name).
- `description:` — string; for user-invocable skills a TRIGGER/SKIP description; for internal skills a "composed by name into X" note.
- `user-invocable:` — boolean. `true` ⇒ it is a slash command; `false` ⇒ internal, composed by name only.
- `argument-hint:` — string, only on user-invocable skills; e.g. `"[m<NN>/f<NN> | m<NN>/c<NN>]"`, `"[m<NN>]"`. Documents the `$ARGUMENTS` shape.
- `metadata:` → `portability:` — one of exactly three tokens: `generic-workflow`, `project-binding`, `project-specific` (coordinator §6 defines the vocabulary). This is a **project-defined** metadata key (not a Claude Code built-in) that the corpus uses to classify what a host must rewrite when porting. It rides `metadata:` deliberately so it adds zero always-on context cost.

No skill uses `allowed-tools:` in frontmatter (the corpus gates tools via the agents' `tools:` field and `settings.json` permissions, not per-skill).

### 1.3 Progressive disclosure & how skills compose OTHER skills

Two composition mechanisms, both explicitly designed and enforced:

**(a) Bundle-internal progressive disclosure — `references/`, `prompts.md`, `template-*.md`, `workflow-*.md`.** A skill's `SKILL.md` is the always-loaded entry; supporting files load only at the step that needs them. Concrete examples:
- `plan-feature/`: `SKILL.md` + `prompts.md` + `references/authoring-specs.md` + `template-feature.md` + `template-task.md`.
- `plan-milestone/`: `SKILL.md` + `prompts.md` + `template-milestone.md` + `template-tracker.md`.
- `review-milestone/`: `SKILL.md` + `prompts.md` + `template-presentation.md` + `template-retrospective.md` + `template-review.md`.
- `asset-viewer/`: `SKILL.md` + `template-material.md` + `template-widget.md` + `workflow-material.md` + `workflow-widget.md` + `algorithmic-work.md`.
- `implement/`: `SKILL.md` + `workflow-spine.md` (the router loads the spine only when routing).
- `feature-close/`: `SKILL.md` + `prompts.md`.

`workflow-spine.md` states the discipline explicitly: *"Progressive disclosure — load in this order. Load the `dispatch-floor` skill first and eagerly … Then compose / load each of the rest only at the step that needs it."*

**(b) Cross-skill composition "by name" (NOT file reach-in).** The sanctioned way one skill reuses another is to **compose a `user-invocable: false` skill by name and inline its section into an invocation prompt**. The corpus forbids a skill from reading another bundle's internal files directly (Process Owner enforces `breaking-change: cross-bundle-skill-reach-in`; `dm-doc-audit.sh`/pre-commit sweep this). Concrete composition chains:
- The `/implement` spine composes, per the coordinator contract §5, into each subagent prompt: `task-prompts` §1 (author) or §2 (review) + `output-contract` (relevant section) + `role-common` + (review only) `review-craft` + (author only) `execution-craft`. A standard footer from `output-contract` §5 is appended.
- The `coordinator` skill is read **only by the main session** and is *never* composed downward into any subagent (frontmatter says so; `role-common`/`review-craft` restate the self-containment rule).
- `state-model` and `plan-model` are "single-home" reference skills: other skills *name the concept and point* (`"the container spec home (state-model)"`) rather than restating the shape. Their frontmatter marks them non-user-invocable.

**"Read X in full" instruction pattern.** Orchestrating skills open with e.g. `implement/SKILL.md`: *"Read `.claude/skills/coordinator/SKILL.md` in full before invoking any subagent."* This is a directive to the model to load a named skill file — the harness must support a skill referencing another skill file by path for the main-session model to read.

### 1.4 Slash commands vs internal skills

- **Slash commands (`user-invocable: true`, 8):** `/implement`, `/collaborate`, `/merge`, `/plan-feature`, `/plan-milestone`, `/review-milestone`, `/status`, `/create-mod`.
- **Internal (`user-invocable: false`, 16):** coordinator, dispatch-floor, state-model, plan-model, output-contract, role-common, review-craft, execution-craft, form-craft, close-synthesis, retrospective-synthesis, feature-close, task-prompts, asset-viewer, plus `workflow-spine.md` as a bundle file of `implement`.

### 1.5 How skills invoke subagents / Task / EnterWorktree / dm-* scripts

- **Subagent/Task:** skills invoke authors and reviewers as **fresh `Task` invocations with `subagent_type: <agent-name>`** (workflow-spine Step 2/3, collaborate Step 4). Fan-outs are "invoke every relevant vantage in parallel in one message." The orchestrator captures **only the bounded return YAML** (the thin-dispatcher invariant, dispatch-floor §4).
- **EnterWorktree:** called by the `/implement` spine and `/collaborate` (main-session orchestrators). `EnterWorktree(name: "m<NN>-<f|c><NN>")` creates; `EnterWorktree(path: <absolute worktree path>)` re-enters. Explicitly noted as *"a main-session orchestrator tool"* — never used inside a subagent.
- **dm-* scripts:** skills call `tools/dm-commit.sh`, `dm-set-status.sh`, `dm-preflight.sh`, `dm-task-count.sh`, `dm-status.sh`, `dm-status-check.sh`, `dm-merge-gate.sh`, `dm-verify.sh`, `dm-metrics.sh` — always as *"one simple allowlisted invocation, never a chained `git add … && git commit …` string the harness cannot statically analyze."* This design choice exists **specifically so the permission allowlist can match the command** (see §3).

---

## 2. Agents

### 2.1 Full roster + purpose

9 agents under `.claude/agents/*.md`. They are **specialist reviewer/author viewpoints**, not tools. Each is a persona with an owned surface, a rule corpus, a rule-name vocabulary, and escalation targets.

| Agent | color | tools | Purpose (altitude) |
|---|---|---|---|
| `coder` | blue | Read, Grep, Glob, **Edit, Write, Bash** | The only role that *writes the project* (code/data/tests). Also reviews code diffs (function-internal + cross-function intra-file quality). |
| `architect` | blue | Read, Grep, Glob, **Edit, Write** | System-shape: crate/module boundaries, layering (engine→sim→observation→consumers), acyclic Cargo graph, data-vs-code at system altitude. Authors `architecture.md`. |
| `author` | cyan | Read, Grep, Glob, **Edit** | Prose-craft FORM pass (concision/clarity/structure). Never changes meaning; flags meaning-risks. No `Write` (cannot create files). |
| `designer` | orange | Read, Grep, Glob | Visual/audio/animation aesthetic coherence. **Read-only** (no Edit/Write/Bash). |
| `game-designer` | pink | Read, Grep, Glob, **Edit, Write** | Mechanics coherence + steward of GDD/PRD/product-brief. Authors those three docs. |
| `modder` | green | Read, Grep, Glob, **Edit, Write, Bash** | Mod-ergonomics / data-vs-code counterforce. Content-naming counterforce (fires on `enum`/`match`/`const` naming content). Authors `.schema.yaml`. |
| `player` | yellow | Read, Grep, Glob, **Edit, Write, Bash** | Bot-driven playtest (Level 4). Bot-experience counterforce. Authors bot profiles, scenarios, bot tests, SDD interaction sections, Level-4 test plan content. |
| `process-owner` | purple | Read, Grep, Glob, **Edit, Write, Bash** | Process-friction pattern observer + retrospective steward. Authors `.claude/**`, `doc/dev/**`, `doc/milestones/**` process content. |
| `tester` | cyan | Read, Grep, Glob, **Edit, Write, Bash** | Test-suite custodian (Levels 1–3 + L5 scaffolding + harness). Authors test plans, `testing-strategy.md`, `demon_test_support/**`. |

### 2.2 Agent frontmatter schema (every distinct key)

Every agent file carries exactly these keys:

- `name:` — agent id, used as `subagent_type`.
- `description:` — a long routing string (the "Fires on … / Engages on … / Route out …" grammar). **This is the routing key** (§2.3). Auto-injected into the orchestrator's context.
- `tools:` — comma-separated allowlist of tools this agent may call (§2.4).
- `color:` — display color (blue/cyan/orange/pink/green/yellow/purple).
- `permissionMode:` — value `default` on all 9 agents (the only value observed).
- `metadata:` → `portability:` — `project-specific` on all 9 (the roster stays behind on a port).

Two agents also carry an HTML-comment sentinel just under the frontmatter, asserted by `dm-doc-audit.sh` Check 2: modder `<!-- required-present: modder-content-naming | home: description -->` and player `<!-- required-present: player-gameplay-outcome | home: description -->`.

### 2.3 The description-driven executor/reviewer-selection mechanism

This is the corpus's central routing invention. **Each agent's `description` is auto-injected into the orchestrator's system prompt**, and *all* selection reads off it — no hardcoded agent names where avoidable.

- **Review fan-out (coordinator §2):** *"Each available agent's `description` field is in your system prompt. Engage every agent whose description's delegation trigger applies to the current artefact (phase, touched files, subject). The descriptions are the source of truth."*
- **Author selection (dispatch-floor §3a, the single home):** *"Pick the author whose `description` owns the task's writable-surface paths… For each path in the task's writable surface, find the agent whose description names that path (or a glob containing it); count per agent. If one role's description owns ≥60% of the paths, it leads; otherwise surface the count breakdown to the human. Where multiple descriptions claim the same path, the more specific glob wins."* Plus a **write-tool guard:** *"an agent whose `tools:` lack Edit/Write never leads an authoring dispatch."*

Example of the description grammar (coder, verbatim excerpt): *"Fires on `crates/**`, `data/**` (non-schema), `tools/**`, WGSL files, `Cargo.toml`, `tests/**`, research-findings docs … Route out: owned design docs / module-crate-boundary → Architect; schema / `.schema.yaml` design → Modder; …"* — the "Fires on" clause is the positive trigger, "Route out" disambiguates overlaps.

The corpus even pins two description phrases as counterforce sentinels (coordinator §6): Modder's "Content-naming counterforce" and Player's "a gameplay outcome a bot must reach, perceive, or drive" — asserted present by the doc-audit.

### 2.4 The `tools:` field gates write capability

`tools:` both (a) restricts what the runtime lets the agent call, and (b) feeds the write-tool guard in author selection. The distinct values:
- Read-only reviewers: designer (`Read, Grep, Glob`), author (`Read, Grep, Glob, Edit` — Edit but no Write, so it edits existing prose but creates no files).
- Doc authors without Bash: architect, game-designer (`+ Edit, Write`).
- Full writers with Bash: coder, modder, player, process-owner, tester (`Read, Grep, Glob, Edit, Write, Bash`).

The agent bodies self-police: e.g. coder's *"Writing scope. You hold Read, Grep, Glob, Edit, Write, Bash. The writable surface is exactly what the invocation contract declares (an explicit list of absolute paths); empty ⇒ read-only."* — so tool possession is necessary but the per-invocation "writable surface" parameter is the actual gate. A subagent refuses (halts) if asked to write outside the declared surface (`role-common` + each agent's refuse clause).

---

## 3. settings.json + settings.local.json

### 3.1 Permissions model

`.claude/settings.json` `permissions.allow` (project-committed):

```
WebSearch
Bash(cd:*)  Bash(ls:*)  Bash(wc:*)  Bash(grep:*)  Bash(sed:*)  Bash(find:*)
Bash(git:*)  Bash(cargo:*)  Bash(curl:*)  Bash(cat:*)  Bash(mkdir:*)  Bash(awk:*)
Bash(xargs grep:*)  Bash(xargs ls:*)  Bash(jobs:*)  Bash(wait)  Bash(tasklist)
Bash(echo:*)  Bash(tools/dm-*.sh:*)
WebFetch(domain:docs.rs)  WebFetch(domain:raw.githubusercontent.com)
WebFetch(domain:github.com)  WebFetch(domain:book.shipyard.rs)
WebFetch(domain:rust-gamedev.github.io)  WebFetch(domain:gamedev.rs)
Read(//tmp/**)
```

`.claude/settings.local.json` `permissions.allow` (developer-local, additive):

```
Bash(git add *)  Bash(git diff *)
Bash(bash tools/dm-commit.sh:*)  Bash(bash tools/dm-preflight.sh)
```

Matcher forms the harness must support:
- **`Bash(<prefix>:*)`** — allow any Bash command whose program/args match the prefix (`Bash(cargo:*)` = any cargo command). `Bash(wait)` and `Bash(tasklist)` are exact (no `:*`).
- **`Bash(tools/dm-*.sh:*)`** — a **glob inside the matcher** to allow the whole `dm-*` script family. The dm-scripts-as-single-invocations design (§1.5) exists so this one line covers them all statically.
- **`WebFetch(domain:<host>)`** — per-host fetch allowlist.
- **`Read(//tmp/**)`** — path glob for the Read tool.
- Bare tool name (`WebSearch`) — allow the tool unconditionally.

### 3.2 The `worktree` config block

```json
"worktree": { "baseRef": "head" }
```

`baseRef: "head"` — new worktrees created via `EnterWorktree` base off current `HEAD`. (dispatch-floor notes `EnterWorktree` bases off a commit, not the working tree, so a dirty `main` checkout does not block entry.)

### 3.3 The `hooks` config

```json
"hooks": {
  "PreToolUse": [
    { "matcher": "Edit|MultiEdit|Write",
      "hooks": [ { "type": "command", "command": "bash tools/dm-worktree-guard.sh" } ] }
  ],
  "PostToolUse": [
    { "matcher": "Bash",
      "hooks": [ { "type": "command",
        "if": "Bash(git *)",
        "command": "[ \"$(git config core.hooksPath 2>/dev/null)\" = \".githooks\" ] || git config core.hooksPath .githooks" } ] }
  ]
}
```

Mechanics the harness must reproduce:
- **`PreToolUse` / `PostToolUse`** event kinds.
- **`matcher:`** — a regex/alternation over tool names (`Edit|MultiEdit|Write`; `Bash`).
- **`if:`** — a *conditional* on the specific tool-call payload (`Bash(git *)` = only when the Bash command starts with `git`). This gates the PostToolUse command so it runs only after git commands.
- **`command:`** — a shell command run by the harness (not the model). The PreToolUse guard receives the tool-call payload as JSON on **stdin** and may emit `hookSpecificOutput` JSON on **stdout** (see §4.2).
- Hooks run relative to the session cwd; scripts are referenced by repo-relative path (`bash tools/dm-worktree-guard.sh`).

---

## 4. Hooks & git handling

### 4.1 `.githooks/pre-commit` (21,885 bytes) — what it enforces

A large bash gate wired via `core.hooksPath .githooks`. Sections:
1. **Rust/Cargo checks** (only when `.rs`/`Cargo.toml`/`Cargo.lock` staged): `cargo fmt --all -- --check`, `cargo clippy --all-targets --all-features -- -D warnings`, `cargo test --all`.
2. **Clerical check 1 — banned clippy silencers** in production `.rs` (excludes test files): greps for `#[allow(clippy::(too_many_lines|too_many_arguments|cognitive_complexity)` and blocks; cites `.claude/agents/coder.md §Constraints`.
3. **Clerical check 2 — tools bite-test lane:** any staged `tools/*.sh` runs its sibling `tools/<base>.test.sh`; a staged `tools/fixtures/skill-eval/**` maps to `dm-skill-eval.test.sh`. Auto-registering (no hardcoded test names).
4. **Clerical check 3 — dangling register references:** sweeps for `R-NNN` refs that no longer resolve.
5. **Clerical check 4 — reference-integrity sweep** over process surfaces (`.claude/skills`, `.claude/agents`, coordinator, `doc/dev`, `.githooks`) — sources `tools/dm-strip-corpus.sh`.
6. **Clerical check 5 — process-corpus single-home audit** (mirrors `dm-doc-audit.sh`), cross-checks the data manifest `crates/demon_engine/src/data/manifest.rs`.

The harness dependency is indirect: the corpus assumes **a git commit runs this gate**, and skills treat hook failure as a bug to fix, never `--no-verify`.

### 4.2 How `core.hooksPath` is wired — the PostToolUse hook

The repo does **not** ship a committed `.git/config` setting. Instead the **PostToolUse hook** (`matcher: Bash`, `if: Bash(git *)`) runs after every git Bash call: `[ "$(git config core.hooksPath)" = ".githooks" ] || git config core.hooksPath .githooks`. So the first git command in any session self-heals `core.hooksPath` to `.githooks`, activating the pre-commit gate. **A new harness must run this hook (or set `core.hooksPath` itself) or the pre-commit gate never fires.**

### 4.3 The worktree write-guard — `tools/dm-worktree-guard.sh` + the PreToolUse hook

- Wired as a `PreToolUse` hook on `Edit|MultiEdit|Write`. Reads the tool-call JSON from **stdin**, extracts `tool_input.file_path` (jq-free — greps/sed, un-doubles Windows `\\` escaping).
- **Mode gate:** runs `dm-preflight.sh`; if `mode != worktree` (a main session), exits silent — the guard only applies inside a worktree session.
- **Root:** `git rev-parse --show-toplevel` from the worktree cwd (fallback: nearest enclosing `.claude/worktrees/<name>`).
- **Check:** canonicalizes both paths (`cygpath -m` on Windows, else `realpath -m`) and prefix-compares. **Outside the worktree → warn; inside → silent.**
- **Warn, never block:** emits `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow","additionalContext":"<text>"}}` on stdout and exits 0 — the write proceeds AND the warning text reaches the model context. Any internal error degrades to silent-allow with a stderr breadcrumb (never wedges the session). The one expected legitimate cross-tree write is `/merge`'s `$MAIN_PATH` rollup.
- Root CLAUDE.md restates the contract for the model: *"A `PreToolUse` guard warns (it never blocks) when an Edit/Write targets an absolute path outside the active worktree. Treat the warning as a stop-and-fix."*

The harness must support: PreToolUse stdin JSON payload with `tool_input.file_path`; stdout `hookSpecificOutput` with `permissionDecision: allow` + `additionalContext` injected into context.

### 4.4 The commit flow: dm-commit / dm-preflight / dm-set-status

All commit/status mutation flows through allowlisted single-invocation scripts (so the permission allowlist can match them, and the pre-commit hook fires):

- **`tools/dm-commit.sh "<message>" <path>…`** — stages **exactly** the named paths (never `-A`/`-u`, so stray files never sweep in), guards each path is inside the repo toplevel (canonicalized compare — the surviving guard against the worktree path-trap), refuses an empty commit (exit 3), then `git commit -m` with the **pre-commit hook firing** (never `--no-verify`; propagates the hook's exit code so the autonomous loop sees failure).
- **`tools/dm-preflight.sh`** — read-only worktree detection: compares `git rev-parse --git-common-dir` vs `--git-dir`; emits `mode=worktree|main`, `main_path=<abs>`, `branch=<name|HEAD>`. Never mutates.
- **`tools/dm-set-status.sh <file> <STATUS>`** — flips a `**Status:**` line and commits (derived message `… mark task <STATUS>`); `--no-commit` form stages only (for batching into one rollup commit); idempotent (already-at-target is a no-op that stages nothing).

**Allowlisting:** `Bash(tools/dm-*.sh:*)` (settings.json) covers the family; settings.local.json adds `Bash(bash tools/dm-commit.sh:*)` and `Bash(bash tools/dm-preflight.sh)` for the `bash <script>` call form. **Commit ownership invariant:** only the orchestrating skill (Coordinator, main session) runs `git commit`/status transitions — no author subagent commits (role-common single-home + coordinator §4). Authors may `git add` and verify but the calling skill commits per logical unit (`m<NN>/f<NN>/t<NN>: <desc>`).

Other supporting scripts: `dm-verify.sh` (runs `.githooks/pre-commit` against the current index, reports CLEAN/FAIL), `dm-merge-gate.sh` (classifies merge diff → `gate=skip|run`, fail-closed exit 2), `dm-status.sh` / `dm-task-count.sh` / `dm-status-check.sh` / `dm-metrics.sh` / `dm-doc-audit.sh` / `dm-skill-eval.sh`. Each has a matching `.test.sh` bite-test.

---

## 5. Worktree lifecycle

### 5.1 EnterWorktree usage & the `.claude/worktrees/<name>/` convention

- **One worktree per container** (feature or chore). Worktrees live under `.claude/worktrees/<name>/` (observed live: `.claude/worktrees/m09-c26/`, `.claude/worktrees/m09-f06/` — each a full checkout with its own `.claude/`, `crates/`, per-crate `CLAUDE.md`).
- **Flat worktree name grammar** (state-model §Branch & worktree name grammar): `m<NN>-<f|c><NN>` (e.g. `m09-c04`) — **never** `m<NN>/…` because a `/` would nest the directory.
- **Entry (dispatch-floor §1):** run `dm-preflight.sh`; on `mode=worktree` do nothing (already inside); on `mode=main` probe `git worktree list --porcelain` for a path-basename or branch match:
  - Found (resume) → `EnterWorktree(path: <absolute worktree path>)`.
  - Not found (fresh) → `EnterWorktree(name: "m<NN>-<f|c><NN>")`.
- **The leftover `worktree-<name>` branch:** `EnterWorktree(name:)` creates a base branch `worktree-<name>` as a side effect; the git-setup then checks out the real container branch, superseding it. `/merge` reaps the leftover; skills are told not to delete or avoid it inline.

### 5.2 Branch-name grammar + merge/reap flow

- **Container branch:** `m<NN>/f<NN>-<slug>` (feature) or `m<NN>/c<NN>-<slug>` (chore). One branch per container, never per task; tasks land as commits on it.
- **Container-branch glob** (the single probe/resolve key): `m<NN>/<f|c><NN>*`.
- **Merge (`/merge`, human-initiated, container grain):** one `git merge --no-ff` of the container branch; then reap. Worktree mode: `git -C "$MAIN_PATH" merge --no-ff`, `git checkout --detach` (release the branch), `git -C "$MAIN_PATH" branch -d`, attempt `worktree remove --force` (Windows often fails silently → auto-reaped next `/merge`).
- **Auto-reap (Step 2 of `/merge`):** removes orphaned detached worktrees whose HEAD is an ancestor of main, and orphaned `worktree-*` base branches (`git branch -d`, never `-D`, as a second guard).

### 5.3 Parallel sessions — one worktree per container

*"The unit of parallelism is the worktree"* (dispatch-floor §2). Independent **containers** run concurrently in separate worktrees; the dependency graph is the only concurrency gate (a container's worktree may start only when all its dependency-features are merged to main). Tasks **inside** one worktree never run concurrently — sequential in dependency order. Cross-worktree state need not align until merge. This maps cleanly to "one container per container/sandbox" for a cloud harness.

---

## 6. Subagent / recursive dispatch patterns

### 6.1 Thin-dispatcher / fresh-context model

The main-session orchestrator is a **pure dispatcher** (dispatch-floor §4): it issues each executor and each reviewer as a **fresh `Task` invocation** (a DAG of fresh contexts — no context survives across cycles, "the acyclic review loop"), captures **only the bounded return YAML**, persists per-cycle state to the **on-disk execution-log** (never to its own context), and never accumulates task-body content (no diffs/file-bodies/review-prose held in-session). Non-trivial spec edits are delegated to a fresh planning subagent; close synthesis to a fresh synthesiser subagent; the coordinator makes only simple one-line edits itself (status flips, one-line table updates).

### 6.2 Recursion depth & fan-out

- **Depth is bounded — agents do NOT dispatch sub-agents.** Fan-outs are **flat**: the orchestrator invokes description-matched agents in parallel; agents return findings; agents never spawn their own Task calls. Even the "lens fan-out" (when a single surface yields <2 vantages) *"stays flat (parallel invocations of the description-matched agent(s), no sub-agent recursion)."* Effective recursion depth = 1 (main session → subagent).
- **Fan-out review (parallel, one message):** every relevant vantage engaged concurrently for close, milestone-review, and planning fan-outs. In-loop review uses a **risk-tiered set** (workflow-spine §3): **T3** full roster (new substrate / cross-crate contract / spec-flagged), **T2** standard (Coder + surface owner(s) + triggered counterforces), **T1** surface-owner only (doc/config/data tweak) — but a triggered counterforce (Modder/Player/Tester) always fires regardless of tier.
- **Scoped re-review** after an obvious-fix round: re-fire only the reviewers that returned NEEDS_CHANGES plus any owner whose surface the fix's new hunks touch.

### 6.3 Per-task execution-log protocol

Every task writes one durable **execution-log file** at `doc/milestones/m<NN>-*/features/<f|c><NN>-*/execution/t<NN>.md` (dispatch-floor §3, state-model). It carries the author's locked `files_changed + summary + followups`, decisions within spec, spec-deviations-with-rationale, batched questions for the close, in-loop process observations, and applied minor-adaptations. **What a reviewer reads is exactly `{task spec + diff + execution-log}`** — the reviewer reconstructs intent from the durable log, not a coordinator narrative. A coordinator-appended `**Loop metrics:**` trailer line records tier/rounds/first_pass (carve-out: no agent prompt mentions it).

### 6.4 Context passed to subagents; bounded return (locked YAML)

- **Invocation contract (coordinator §5):** every invocation prompt declares three parameters at the top: **engagement** (an `Engagement:` label), **writable surface** (explicit path set; empty ⇒ read-only), **output contract** (which locked YAML block to return). The orchestrator composes `output-contract` + `role-common` (+ `review-craft` for review / `execution-craft` for authoring) into the prompt by name, plus the standard footer.
- **Bounded return = a locked YAML block that IS the agent's final message** (nothing before/after). Shapes (output-contract): §1 findings/review (gating — `verdict`, `critical[]`, `warnings[]`, `suggestions[]`, `escalated[]`, `notes`); §2 plan-attendance (advisory, `verdict: PASS` always, `plan_input[]`); §3 authoring (`files_changed`, `summary`, `followups`); §4 role-specific (Game-Designer `mechanic_priority[]`, Author form-pass block). Empty lists written as explicit literals (`critical: []`). Reports capped ≤300 words (Tester ≤600).
- **Malformed-return protocol:** re-invoke once with a conformance note; a second malformed return resolves by engagement class (gating → synthetic NEEDS_CHANGES; advisory → record gap; authoring → surface to human).
- **The harness requirement:** reliably capture "the subagent's final message" verbatim so the orchestrator can parse the YAML.

---

## 7. CLAUDE.md hierarchy

- **Root `CLAUDE.md`** (`F:/Arne/Projekte/DemonMatrix/CLAUDE.md`, ~6 KB): project identity, design pillars, directory map, core-doc pointers (`doc/plan/*`), tech stack, naming conventions, layering, and a **Shell Commands** section that is load-bearing for worktree behavior: *"NEVER use `cd` … It is either the project root or a worktree under `.claude/worktrees/<name>/`"*, `git -C "<dir>"` guidance, and the worktree write-guard explanation.
- **Per-crate `CLAUDE.md` (auto-injected):** each crate/tool directory has one — `crates/demon_assets`, `demon_audio`, `demon_bot`, `demon_engine`, `demon_game`, `demon_observation`, `demon_render`, `demon_session`, and `tools/asset_viewer`. Structure (see `demon_engine/CLAUDE.md`): `**Role:**`, `**Conformance test:**` (e.g. engine: *"Would this code make sense in a completely different game?"*), `## What belongs here`, `## What does NOT belong here`, `## Data owned`, `## Cargo features`, `## Dependencies`.
- **How they layer / auto-inject:** the agent files rely on directory-scoped auto-injection — coder: *"the crate-local `**Role:**` / `**Conformance test:**` blocks in each crate's `CLAUDE.md` are crate-altitude additions the runtime injects when you read files in that crate"*; architect and tester say the same (*"Auto-injected when you Read a file under that crate"*). **The harness must inject a directory's `CLAUDE.md` into context when the model reads/edits a file under that directory** (the standard nearest-ancestor `CLAUDE.md` mechanism), and support the root + nested layering. (Note: the two worktrees each carry their own full copy of the root and per-crate CLAUDE.md, since a worktree is a full checkout.)

---

## 8. Other Claude-specific mechanisms

- **`$ARGUMENTS` handling:** user-invocable skills parse `$ARGUMENTS` for a container/milestone reference (`m<NN>/f<NN>` | `m<NN>/c<NN>` | `m<NN>`). `argument-hint` frontmatter documents the shape. Skills branch on argument-present vs absent (e.g. `/implement` Step 1: argument → resolve that container; none → find next runnable).
- **`argument-hint`:** present on all 4 container-scoped slash commands; `/status`, `/create-mod` omit it (no argument).
- **`permissionMode: default`** is the only value used across all 9 agents. (No `plan`, `acceptEdits`, `bypassPermissions` observed — the harness only needs the default gate.)
- **System-prompt injection / self-containment:** agent `description` fields are auto-injected into the orchestrator's system prompt (the routing surface). Subagent prompts are **self-contained** by rule — the coordinator contract is never quoted downward; `output-contract` §5 self-containment clause forbids a subagent prompt from citing `coordinator/SKILL.md`. The **standard composition footer** (output-contract §5) is appended verbatim to every composed prompt: *"Empty lists are written as explicit literals … Report findings and facts only … This prompt is self-contained … Think carefully before responding — apply maximum reasoning effort."*
- **Output-contract / locked-block convention:** the agent's final message IS a single YAML block (§6.4). The harness must treat the final assistant message as the machine-parseable return value.
- **Reasoning-effort steering by prompt text:** the footer's *"apply maximum reasoning effort"* is how the corpus asks for high effort (the old codex config set `model_reasoning_effort = "high"` — the new harness should map this notion).
- **`metadata.portability` three-token vocabulary** (`generic-workflow` / `project-binding` / `project-specific`): a port hint, not runtime-load-bearing, but the corpus's single-home audit (`dm-doc-audit.sh`) checks it.
- **Single-home / sentinel discipline:** `<!-- single-home: … -->` and `<!-- required-present: … -->` HTML-comment markers are asserted by `dm-doc-audit.sh` + the pre-commit reference-integrity sweep. Not a Claude Code primitive, but the corpus's own consistency mechanism the harness's git hook must keep running.
- **MCP:** none. No MCP servers configured or referenced anywhere in `.claude/`. The Google-Drive-style MCP tools are not part of this project.
- **WebSearch / WebFetch:** allowed (WebSearch unconditional; WebFetch domain-scoped to Rust doc hosts). Agents may cite web research; research-task authorship writes findings docs under `doc/dev/research/`.

---

## Feature-support checklist for the new harness

Each item is a concrete requirement the DemonMatrix corpus relies on. A GPT/Codex harness must satisfy all of these to run the corpus unchanged.

**Skills & commands**
- [ ] Discover skills at `.claude/skills/<name>/SKILL.md` and parse YAML frontmatter keys: `name`, `description`, `user-invocable`, `argument-hint`, `metadata.portability`.
- [ ] Route `user-invocable: true` skills as slash commands (`/implement`, `/collaborate`, `/merge`, `/plan-feature`, `/plan-milestone`, `/review-milestone`, `/status`, `/create-mod`).
- [ ] Keep `user-invocable: false` skills non-slash but referable (the model reads them by path and "composes them by name" into prompts).
- [ ] Substitute `$ARGUMENTS` into the invoked skill; honor `argument-hint` shapes (`m<NN>/f<NN>` etc.).
- [ ] Support bundle-internal progressive-disclosure files (`prompts.md`, `references/*.md`, `template-*.md`, `workflow-*.md`) loaded on demand.
- [ ] Let a skill instruct the model to "read `<other skill file>` in full" (path-based cross-file reads).

**Agents & subagent dispatch**
- [ ] Register agents from `.claude/agents/*.md`; parse frontmatter: `name`, `description`, `tools`, `color`, `permissionMode`, `metadata.portability`.
- [ ] Auto-inject every agent's `description` into the orchestrator's context (the routing surface).
- [ ] Provide a `Task`-equivalent that spawns a **fresh-context subagent** selected by `subagent_type: <agent-name>`.
- [ ] Support **parallel** subagent dispatch in a single orchestrator turn (fan-out) and capture each subagent's **final message verbatim** as the return value.
- [ ] Enforce per-agent `tools:` allowlists (gate Edit/Write/Bash by agent), so read-only reviewers cannot write.
- [ ] Honor `permissionMode: default`.

**Permissions & settings**
- [ ] Parse `.claude/settings.json` + `.claude/settings.local.json`, merging `permissions.allow`.
- [ ] Support matcher forms: bare tool name; `Bash(<prefix>:*)`; `Bash(<exact>)`; `Bash(<glob>:*)` (e.g. `tools/dm-*.sh`); `WebFetch(domain:<host>)`; `Read(<pathglob>)`.
- [ ] Support the `worktree` config block with `baseRef` (`head`).

**Worktrees**
- [ ] Provide an `EnterWorktree` orchestrator tool with `name:` (create) and `path:` (re-enter), creating worktrees under `.claude/worktrees/<flat-name>/` based off `HEAD`.
- [ ] Accept the side-effect `worktree-<name>` base branch and the container branch `m<NN>/<f|c><NN>-<slug>` grammar; support `git worktree list --porcelain` probing.
- [ ] Support one worktree per container running concurrently (parallel container sessions).

**Hooks & git**
- [ ] Support `PreToolUse` and `PostToolUse` hook events with `matcher` (tool-name regex/alternation), `if:` (conditional on the tool-call payload, e.g. `Bash(git *)`), and `command:` (shell command run by the harness, not the model).
- [ ] Deliver the tool-call payload to a PreToolUse `command` as JSON on **stdin** (with `tool_input.file_path`).
- [ ] Accept a PreToolUse hook's stdout `{"hookSpecificOutput":{... "permissionDecision":"allow","additionalContext":"…"}}` — the write proceeds AND `additionalContext` is injected into the model context (warn-only guard).
- [ ] Run the PostToolUse `core.hooksPath` self-heal after git commands (or set `core.hooksPath .githooks` at session start) so `.githooks/pre-commit` fires on every commit.
- [ ] Ensure `git commit` invokes the repo pre-commit hook (never `--no-verify`) and surfaces its exit code to the model.

**CLAUDE.md hierarchy**
- [ ] Auto-inject the nearest-ancestor `CLAUDE.md` when the model reads/edits a file (root + per-crate/tool layering), including inside worktree checkouts.

**Output/return conventions**
- [ ] Treat a subagent's final assistant message as its machine-parseable return (locked YAML block); support a re-invoke-once-on-malformed-return retry.
- [ ] Preserve verbatim reasoning-effort steering from prompt text ("apply maximum reasoning effort").

**Not required (absent in this project)**
- [ ] MCP servers — none used.
- [ ] `allowed-tools` in skill frontmatter — not used (tools gated via agent `tools:` + settings).
- [ ] `permissionMode` values other than `default` — not used.

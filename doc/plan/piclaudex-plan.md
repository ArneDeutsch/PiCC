# PiClauDex — Feature Plan (WHAT & WHY)

> **Status:** Target definition. This document states **what** PiClauDex will do and **why**,
> and — equally — **what it deliberately will not do** and why. It is written as an
> acceptance target: when the behaviors and criteria below hold, the harness is "done" for
> its first complete version. It intentionally omits **how** (architecture, module layout,
> algorithms) — that lands in later design documents.
>
> **Baseline:** All support claims are stated relative to **Claude Code ~v2.1.x (mid-2026)**,
> the reference surface researched in `doc/research/`. See §17 (Forward-compatibility) for how
> this baseline is tracked and evolved.
>
> **Grounding:** This plan builds on `doc/research/00`–`06` and a subsequent gap-analysis
> sweep against the live Claude Code feature surface. Where the research and the docs diverge,
> the live documentation wins.

---

## 1. Purpose

PiClauDex is an agentic harness that lets **GPT/Codex models — driven from a personal
ChatGPT/Codex subscription — run projects authored and tuned for Claude Code, unchanged.**

Many projects carry a `.claude/` corpus: `CLAUDE.md` hierarchies, skills, subagents,
`settings.json` permissions and hooks, `.claude/rules/`, and reliance on runtime features like
worktree-based workspace isolation and parallel sessions. The goal is a harness where GPT
models read and honor those Claude-format artifacts and behaviors natively, with **no changes
to the target project**.

The reference conformance project is **DemonMatrix** — an elaborate multi-agent,
worktree-parallel, git-native Rust corpus (24 skills, 9 agents, `dm-*.sh` tooling). DemonMatrix
is the **floor**, not the spec: it must run end-to-end, but the design target is **general
Claude Code project compatibility**, not a bespoke DemonMatrix runner.

We do not need 100% Claude Code parity. We need enough fidelity that real Claude Code projects
run on GPT models without friction or adaptation.

**Base harness.** PiClauDex is built as an extension bundle on **Pi** (`earendil-works/pi`, MIT,
TypeScript), which already solves the two hardest problems: spending a ChatGPT/Codex
subscription and abstracting the model provider. The Pi choice is an assumption of this plan;
fork-vs-depend is a HOW question deferred to a design document (§18).

---

## 2. Governing principles

These principles decide the hard cases throughout the rest of the document.

### 2.1 Two tiers of fidelity, with different bars

- **Mechanical fidelity — strict, must match.** The load-bearing runtime mechanics — worktree
  entry/exit, git handling, skill/agent loading, hook dispatch, argument substitution,
  progressive disclosure — must behave the way the **unchanged project expects**. The fidelity
  bar is defined by **what the project's own tooling and skills assume**, not by matching Claude
  Code's private internal file formats. This is what makes a project usable interchangeably
  across Claude Code and PiClauDex.
- **Behavioral fidelity — best-effort and steerable.** GPT models are not Claude and will never
  behave identically. That is acceptable and unavoidable. We narrow the gap with a **harness-side
  model-steering layer** (§13.2), and accept that occasional project-side wording changes may be
  made by the user — but such changes are **out of scope for harness development**; the standing
  goal remains "runs unchanged."

### 2.2 The completeness rule (floor) + tier-up (named subsystems)

- **Floor — never break, everywhere.** For *any* Claude artifact, field, setting, tool name, or
  hook event, the harness either **fully honors it** or **gracefully degrades it** — a visible,
  documented no-op — and **never crashes, corrupts state, or silently misbehaves**. No project
  input produces an unhandled failure.
- **Tier-up — full function for named subsystems.** For the subsystems in §4 we go beyond
  "don't break": every field the format defines is **functional**, not merely parsed — including
  fields DemonMatrix never uses. Rationale: (a) other projects use other fields, and a dead field
  is a bad surprise; (b) our own reference workflows evolve, and we must not be forced to patch
  the harness every time a project adopts a new-but-existing Claude feature.

### 2.3 No changes to the target project

The harness never writes to a project's tracked files to make it run. Harness configuration
(model choice, effort, steering text, auth) lives **outside** the project or in
harness-owned/ignored locations. The one project-level convention we rely on — `.claude/worktrees/`
being gitignored — is a standard Claude Code expectation, not a PiClauDex-specific edit.

### 2.4 Forward-compatible by default

Unrecognized inputs — a new frontmatter field, settings key, tool name, or hook event, whether
from a future Claude Code release or simply not yet assessed — **degrade safely and are
surfaced**, never fatal. A project using a feature we don't yet support runs, minus that feature.
(Mechanism and tracking in §17.)

### 2.5 Interoperability model: compatible-but-independent

The user must be able to switch providers at will on one project, and run **multiple parallel
sessions on different worktrees with different models**. The requirement is **file/git-level
compatibility only** — the two harnesses do not exchange live session state. A worktree or git
history produced by one is clean and usable by the other; we do **not** promise mid-flight
handoff of a live worktree between harnesses.

### 2.6 Verify NFRs, don't assume them

A feature is not "done" because its behavior looks similar. Non-functional requirements —
progressive disclosure / lazy loading, context preservation across compaction, cross-platform
execution — have **explicit acceptance criteria and tests** (§12–§13, §15). "Looks right" is not
"is right."

---

## 3. Discovery, locations & precedence

**What.** Resolve all Claude artifacts across the standard location hierarchy and apply the
documented precedence and merge semantics:

- **Locations:** user (`~/.claude/`), project (`.claude/` and project root), local
  (`*.local.json`, `CLAUDE.local.md`), and managed/policy locations.
- **Monorepo walk-up:** discover project artifacts by walking from the working directory up to
  the repo root; nearest definition wins on name clashes.
- **Merge semantics:** permission rules accumulate across scopes; scalar settings follow
  precedence; `CLAUDE.md` files concatenate root→cwd with nested subdir files injected on demand
  (§4.6); skills/agents/rules from user scope are honored alongside project scope.
- **Installed-plugin content** (§4.9) is discovered from the user's enabled-plugins configuration
  and folded into the same skill/agent/hook/command registries.

**Why.** Projects legitimately place skills, agents, and rules outside the repo (user-level), and
rely on precedence when names collide. Getting discovery/precedence wrong silently changes which
instructions and capabilities are active.

**Done when.** Fixtures that place the same-named skill/agent/rule at multiple scopes resolve to
the documented winner; user-scope-only artifacts are usable in a project that doesn't define them;
managed-policy artifacts are honored where present (low priority, degrade-safe if absent).

---

## 4. Fully-functional subsystems

Each subsystem below is built to full baseline fidelity (§2.2 tier-up). Each states what it is,
its acceptance target ("Done when"), and why it matters.

### 4.1 Skills (`.claude/skills/<name>/SKILL.md`, `.claude/commands/*.md`)

**What.**
- Discover skills; parse the **full** SKILL.md frontmatter set (`name`, `description`,
  `when_to_use`, `user-invocable`, `disable-model-invocation`, `argument-hint`, `arguments`,
  `allowed-tools`, `disallowed-tools`, `model`, `effort`, `context: fork` + `agent:`, `hooks:`,
  `paths:`, `shell:`, `metadata.*`).
- **Progressive disclosure / lazy loading (verified NFR):** name + description enter context at
  startup as a listing; the SKILL.md body loads **only on activation**; bundled files
  (`references/*`, `template-*.md`, `prompts.md`, etc.) load only when read. The rendered body
  stays resident for the session.
- **Invocation:** `user-invocable: true` → slash command; model-invocation via description match
  (unless `disable-model-invocation`); user-only vs model-only honored.
- **Argument substitution:** `$ARGUMENTS`, positional `$N`/`$ARGUMENTS[N]`, named `$name`,
  `argument-hint`, escaping.
- **Variable substitution:** `${CLAUDE_SKILL_DIR}`, `${CLAUDE_PROJECT_DIR}`,
  `${CLAUDE_SESSION_ID}`, `${CLAUDE_EFFORT}`, and the `${CLAUDE_PLUGIN_ROOT}`/`${CLAUDE_PLUGIN_DATA}`
  forms for plugin-bundled skills.
- **Shell injection:** `` !`cmd` `` inline and fenced ` ```! ` blocks preprocessed before the
  model sees content, honoring `shell:` (bash default / powershell) and the
  `disableSkillShellExecution` toggle.
- **`context: fork`** runs the skill as a subagent (composes with §4.3).
- Legacy `.claude/commands/*.md` loaded alongside skills (skill wins on name clash).

**Why.** Skills are the primary extensibility mechanism; the whole DemonMatrix workflow is
encoded as skills. Progressive disclosure is not cosmetic — it is the token-efficiency contract
(§12.1).

**Done when.** A fixture skill using fields DemonMatrix never uses (e.g. `context: fork`,
`paths:`, positional args, `!`-injection under both shells) works; a test asserts the body is
**absent** from context before activation and present after.

### 4.2 Rules (`.claude/rules/`)

**What.** A first-class subsystem distinct from CLAUDE.md. `.claude/rules/**/*.md` (recursive),
at project and user scope. Files **without** `paths:` load unconditionally at session start (same
priority as `.claude/CLAUDE.md`); files **with** `paths:` (glob list) inject **only when the
model touches a matching file**. The `paths:` glob engine is shared with path-scoped skills.

**Why.** This is Anthropic's current recommended pattern for keeping CLAUDE.md small — modern and
large projects put the bulk of their standards here. Omitting it silently drops most of a
project's instructions. (This subsystem was missed in the initial research and added after the
gap-analysis sweep.)

**Done when.** Unconditional rules load at start; a path-scoped rule injects on matching-file
access and not otherwise; user-scope rules layer under project rules; `claudeMdExcludes` is
honored.

### 4.3 Agents & subagent dispatch (`.claude/agents/*.md`)

**What.**
- Register agents; parse the **full** frontmatter set (`name`, `description`, `tools`,
  `disallowedTools`, `model`, `permissionMode`, `maxTurns`, `skills`, `effort`, `color`,
  `isolation: worktree`, `initialPrompt`, `metadata.*`; and the deferred-but-parsed `memory`,
  `mcpServers`, `hooks` — see §7).
- **Description-driven routing:** every agent's `description` is auto-injected into the
  orchestrator context as the routing surface; selection reads off descriptions.
- **Dispatch tool** (`Agent`/`Task`-equivalent): spawn a **fresh-context** subagent by
  `subagent_type`, with the agent body as its system prompt plus the CLAUDE.md/rules hierarchy
  and env; **not** the parent conversation.
- **Parallel fan-out** in one orchestrator turn; capture each subagent's **final message
  verbatim** as the return value (no summarization/wrapping); one-retry-on-malformed convention
  supported.
- **Per-agent `tools:` capability gating** fully honored (this is also the primary security
  control, §6): a read-only reviewer cannot write; an agent without web tools cannot fetch/search.
- **Nested / recursive subagents with a configurable, settings-honored depth cap** (full support,
  beyond DemonMatrix's flat depth-1 usage).
- **`isolation: worktree`** — a subagent may run pinned to its own worktree (composes with §4.4).

**Why.** Subagent fan-out is the heart of multi-agent corpora. Description-driven routing is the
central selection mechanism. Verbatim return is required because skills parse the final message
(often a locked-YAML block) directly. Recursion and depth toggles must be real for the depth
settings to be meaningful and for general projects that nest.

**Done when.** A description-matched review fan-out over a diff dispatches the right agents in
parallel and returns verbatim payloads; a depth-2 nesting fixture works and respects a
depth-cap setting; a read-only agent is prevented from writing; an `isolation: worktree` agent
runs in its own worktree.

### 4.4 Worktrees (`EnterWorktree` / `ExitWorktree`)

**What.**
- `EnterWorktree(name:)` creates `.claude/worktrees/<flat>/` on the expected branch off the
  resolved base ref, records the base commit, and **changes the session cwd** into it.
  `EnterWorktree(path:)` re-enters an existing worktree (creates nothing). Mutually exclusive
  args.
- Honor `worktree.baseRef` (`head` | `fresh`), resolving the base to a concrete commit **before**
  creating.
- **cwd swap is load-bearing** — the project's own scripts detect worktree vs main via standard
  git plumbing, so every subsequent tool call must run inside the worktree; cwd restored on exit.
- **`.worktreeinclude`:** copy matching gitignored files (`.env`, local config) into each new
  worktree so builds/tests work on entry.
- **Windows-tolerant lifecycle:** best-effort remove; reap orphans later; never hard-fail a merge
  on a stuck `worktree remove`; strip reparse points before removal; long-path aware.
- `ExitWorktree(action: keep|remove)` for interactive/non-skill sessions.
- Support one worktree per unit of work running **concurrently** (parallel sessions on one repo),
  locking an active worktree against concurrent cleanup.

**Why.** Worktree isolation enables parallel sessions and is mechanically load-bearing: the
project's tooling probes git state that only exists if we swap cwd and lay the worktree out where
it expects. Mechanical fidelity here is defined by the project's expectations (layout, branch
grammar, detectability), not by matching Claude Code's private base-commit file name.

**Done when.** On a project launched on `main`, entry isolates into `.claude/worktrees/<flat>/`
and the project's own preflight detects worktree mode; `.worktreeinclude` files appear in the new
worktree; a Windows `worktree remove` failure is tolerated and reaped; two worktrees run in
parallel under different models without interference.

### 4.5 Hooks (`settings.json` → `hooks`, plus skill/agent-scoped `hooks:`)

**What.**
- **Event coverage.** Fully support the deterministic command-hook events that gate implemented
  subsystems: `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `SessionStart`, `SessionEnd`,
  `UserPromptSubmit`, `Stop`, `SubagentStart`, `SubagentStop`, `PreCompact`, `PostCompact`,
  `WorktreeCreate`, `WorktreeRemove`. Parse-and-degrade the remaining/experimental/MCP/team events.
- **Schema.** `matcher` (tool-name regex/alternation), `if:` (payload conditional reusing the
  permission-rule grammar, e.g. `Bash(git *)`), `command` with `args`/`shell`/`timeout`/`once`;
  placeholders (`${CLAUDE_PROJECT_DIR}`, `${CLAUDE_PLUGIN_ROOT}`, …). Handler `type: command`
  fully supported; `http` best-effort; `prompt`/`agent`/`mcp_tool` handler types degrade with a
  notice.
- **I/O contract.** Deliver the tool-call payload as **JSON on stdin** (including
  `tool_input.file_path`, Windows doubled-backslashes); honor the stdout contract
  (`hookSpecificOutput.permissionDecision` allow/deny/ask, `additionalContext`, `updatedInput`;
  exit-code 2 = block; plain stdout injected for the context-injecting events). Honor
  `disableAllHooks`.
- **Git-hook interplay.** Ensure `git commit` runs the repo's own pre-commit hook (never
  `--no-verify`) and surfaces its exit code; support the projects' pattern of self-healing
  `core.hooksPath` via a `PostToolUse` hook (or set it at session start).

**Why.** Hooks are the deterministic enforcement layer projects rely on: write-guards, git-gate
wiring, worktree seeding (`WorktreeCreate`), "don't stop until validated" loops
(`Stop`/`SubagentStop`), and compaction re-injection (`PreCompact`/`PostCompact`). Supporting only
`Pre/PostToolUse` would silently drop behavior real projects depend on.

**Done when.** A warn-only `PreToolUse` write-guard warns without blocking and its
`additionalContext` reaches the model; a `WorktreeCreate` hook seeds a new worktree; a
`PostToolUse` `if: Bash(git *)` hook fires only after git commands; `disableAllHooks` disables all.

### 4.6 CLAUDE.md hierarchy

**What.**
- Load root `CLAUDE.md`; **inject the nearest-ancestor `CLAUDE.md` on demand** when the model
  reads/edits a file in a subdir (nested behavior), including inside worktree checkouts.
- **`@import` (recursive, up to 4 hops):** expand `@path` / `@~/path` / absolute imports at load
  time, skipping code spans/fences. This is also the official **AGENTS.md bridge** (`@AGENTS.md`).
- Concatenate root→cwd with the documented precedence; strip block-level HTML comments; honor
  `claudeMdExcludes`.

**Why.** Directory-scoped context injection is how per-module instructions reach the model.
`@import` is load-bearing: many repos ship a thin `CLAUDE.md` that imports `AGENTS.md` or splits
instructions across files; without expansion they load an almost-empty instruction set.

**Done when.** A nested per-directory `CLAUDE.md` injects on file access in that directory; a
`CLAUDE.md` that only `@import`s another file loads the imported content (recursively); excluded
files are skipped.

### 4.7 Slash commands & argument handling

Covered by §4.1 (user-invocable skills + legacy commands). Slash routing, `$ARGUMENTS`/positional/
named substitution, and `argument-hint` are part of the skills subsystem's acceptance.

### 4.8 Tool-surface parity

**What.** Every built-in tool a project can name in `tools:`, `permissions.*`, or a hook `if:`
must **resolve predictably**:
- **Real implementations** for the load-bearing built-ins: `Read`, `Write`, `Edit`, `Bash`
  (from Pi), `Grep`, `Glob`, plus **`WebFetch` and `WebSearch`** (implemented for real — research
  skills and DemonMatrix's allowlist depend on them), and the `Agent`/worktree tools we build.
- **Task tracking** targets the current `Task*` tools (not the deprecated `TodoWrite`).
- **Predictable graceful degradation** for tools we don't implement (e.g. `NotebookEdit`, `LSP`,
  MCP tools): the name still resolves for gating purposes and degrades with a notice rather than
  crashing or breaking a permission/hook match.

**Why.** Subagent `tools:` gating, `deny` rules, and hook `if:` all key off exact tool-name
strings. An unknown tool name must not fail a gate or wedge the session.

**Done when.** A project that lists `WebSearch`/`WebFetch` in an agent's `tools:` can use them; a
`deny` or `if:` referencing a tool we don't implement matches predictably and degrades cleanly.

### 4.9 Installed-plugin content loading

**What.** Discover the user's **already-installed** plugins (from the enabled-plugins
configuration) and fold their contributed **skills, agents, hooks, and commands** into the same
registries, resolving `${CLAUDE_PLUGIN_ROOT}` / `${CLAUDE_PLUGIN_DATA}`. Also parse a
project-bundled `.claude-plugin/` structure without crashing and resolve its bundled content.

**What we do NOT build.** Plugin **installation and marketplace machinery** (`claude plugin
install`, marketplace add/registration, release channels). If a plugin isn't installed, we don't
install it.

**Why.** Plugins are mostly user-installed rather than committed to a target repo, so the install
machinery is out of scope — but a user's installed plugins contribute skills/agents/hooks the
project may rely on, and those must work.

**Done when.** A skill/agent contributed by an installed plugin is discoverable and usable, with
`${CLAUDE_PLUGIN_ROOT}` resolved; a project shipping `.claude-plugin/` loads without error.

---

## 5. Settings surface & honored toggles

**What.** Parse the **full** `settings.json` / `settings.local.json` schema. **Honor every toggle
that gates a subsystem we implement**, including (non-exhaustive): skill-listing budget
(`skillListingBudgetFraction`, `skillListingMaxDescChars`), `disableSkillShellExecution`,
`disableAllHooks`, `skillOverrides`, `claudeMdExcludes`, `includeCoAuthoredBy`/`attribution`
(git handling), `env` (injected into sessions and hook/skill subprocesses), subagent
enable/recursion-depth toggles, `worktree.baseRef`, `cleanupPeriodDays`, `apiKeyHelper`,
`additionalDirectories`. Settings that gate deferred subsystems (§7) are parsed and degrade
safely and are reflected in the compatibility report (§6.2). Apply the full settings **precedence
and merge** semantics (§3).

**Why.** A toggle that silently doesn't take effect is a correctness bug: a project that disables
shell execution or hooks, or tunes the skill-listing budget, expects that to hold.

**Done when.** Flipping each honored toggle changes behavior as specified; a setting for a
deferred subsystem appears in the compatibility report rather than silently vanishing.

---

## 6. Security & permission posture

### 6.1 Posture (deliberately partial, by design)

We do **not** reimplement Claude Code's full interactive security model, for two reasons: parts of
it (auto-mode) are a **server-side classifier we cannot match**, and interactive per-command
approval is fragile — a user cannot reliably interpret complex commands and tends to allow-by-
default anyway.

The posture:
- **Default permissive** (auto-mode-like): the workflow is not blocked and the user is not
  prompted per command.
- **`deny` honored as a hard, non-interactive block** — the one deterministic, useful part of the
  permission model, kept as a real safety valve.
- **`tools:` capability gating fully honored** (§4.3) — this is the primary, deterministic control
  (e.g. "these agents may search the web, those may not" is just tool possession).
- **`allow` / `ask` rules, permission modes, and auto-mode: graceful no-op** (parsed, reported).
- **Permission-matcher grammar is fully implemented regardless**, because `deny` enforcement,
  `tools:` gating, and hook `if:` conditions all reuse it (`Bash(prefix *)`, `Read/Edit(glob)`,
  `WebFetch(domain:*)`, `Agent(type)`, `Skill(name)`, `mcp__…`).

**Why.** This matches how the user actually runs Claude Code (auto mode), keeps a real deny-based
safety valve and deterministic capability gating, and avoids a costly, partly-impossible
reimplementation.

### 6.2 The compatibility report (never silent, never nagging)

**What.** On config load, the harness scans for declared-but-not-fully-honored features
(`ask`/`allow`/modes, MCP, memory, plan mode, etc.) and emits **one consolidated notice per
session**, distinguishing **safety-relevant** divergences (something that would have been
restricted now runs freely) from **functionality gaps** (a feature simply won't work). A
`/doctor`-style command gives the full breakdown on demand. The notice is **suppressible** once
acknowledged. The report is **generated from the capability registry** (§17), so it cannot drift
from actual behavior.

**Why.** The user must never be silently deprived of a security/permission intent, but must also
not be nagged per tool call.

**Done when.** A project with `ask` rules / modes / MCP triggers exactly one startup notice
naming them, with safety-relevant items called out; `/doctor` lists the full picture; suppression
works.

---

## 7. Deferred / gracefully-degraded subsystems (v1)

Each is **parsed, a documented no-op, and a clean seam** for later — never a crash (§2.2 floor,
§2.4). Reflected in the compatibility report (§6.2).

| Subsystem | v1 disposition | Why deferred |
|---|---|---|
| **MCP** (servers, agent `mcpServers:`, `.mcp.json`, MCP tools, Elicitation hooks) | Parse (incl. committed `.mcp.json`) without crashing; MCP tool-name gating degrades predictably | Not used by the reference corpus; Pi is MCP-averse by design; large surface. Clean seam. |
| **Agent `memory:` + auto-memory** | Parse the field; no-op storage | Machine-local, not a committed project artifact; not load-bearing to run a project. |
| **Plan mode / `ExitPlanMode`** | No-op; treat CLAUDE.md "use plan mode" as guidance | User implements planning via own skills with review cycles; not wanted. |
| **`AskUserQuestion`** | Not provided; human interaction happens in plain chat | Explicitly unwanted; chat discussion suffices. |
| **Interactive permission machinery** (`allow`/`ask`/modes/auto-mode) | No-op per §6.1 | Partly server-side; fragile; not how the user works. |
| **Checkpointing / rewind** | Rely on Pi's session model; no rewind parity | UX convenience, not required to run a project unchanged. |
| **Output styles / statusline** | Cosmetic; not honored beyond Pi defaults | Presentation only. |
| **Agent teams, background agents, scheduled tasks (Cron), remote control, LSP, computer use, Artifacts** | Out of scope; names degrade safely | Experimental/niche/surface-specific; not needed to run a `.claude/` corpus. |
| **Managed/enterprise policy, telemetry/OTEL** | Honored where trivially present; otherwise degrade-safe | Enterprise-only; low priority for personal use. |

---

## 8. Auth & subscription

**What.**
- **Primary: direct-backend** ChatGPT/Codex subscription auth (Pi's working path —
  `chatgpt.com/backend-api/codex/responses` with the required `originator`/UA/account headers).
- **Fallback: subprocess** mode (drive a signed-in `codex` child) if edge enforcement tightens or
  policy changes.
- **Single-account only** — no pooling/sharing (a clear ToS violation).
- **Quota introspection:** the user can query how much subscription budget/quota remains.

**Why.** Spending the subscription is the whole premise and the hardest problem — already solved
in Pi. Fan-out sizing and whether a workflow fits the subscription are the **project author's**
concern, not the harness's; but the user must be able to see remaining quota.

**Done when.** A GPT/Codex turn runs against the subscription on Windows and Linux; remaining
quota is queryable; subprocess fallback is documented as available.

---

## 9. Context management & compaction

**What.** Provide **a** compaction strategy (not `/compact` UX parity) that **preserves and
re-injects the project instruction set across compaction**: root `CLAUDE.md`, active/rendered
skills, and unconditional rules survive; nested `CLAUDE.md`/path-scoped artifacts reload on next
relevant access. Wire it to `PreCompact`/`PostCompact` and `SessionStart(source=compact)`.

**Why.** Long multi-agent, worktree-parallel sessions **will** auto-compact. If compaction drops
the project's instructions, the agent diverges hard mid-task. This is load-bearing, not optional —
it was moved out of "deferred" after the gap analysis.

**Reference.** Codex (open source) has its own well-regarded compaction; whether it lives in the
model or the harness is worth studying to inform our strategy. (Reference only; the requirement is
the preservation behavior above, not a specific implementation.)

**Done when.** A session driven past the context limit compacts and a test confirms root
`CLAUDE.md` + active skills + unconditional rules are still present afterward.

---

## 10. Harness control surface (project-external)

**What.** User-facing controls that live outside the project:
- **Model & effort selection**, including mapping the corpus's prose effort-steering ("apply
  maximum reasoning effort") onto the model's effort control where possible; pass-through
  otherwise.
- **Model-steering layer** (§13.2): per-model system-prompt guidance to nudge GPT toward
  Claude-like behavior — harness-side, project-untouched.
- **Quota query** (§8) and **compatibility report / `/doctor`** (§6.2).
- **Operating mode:** interactive is primary (human gates happen in chat); autonomous stretches
  run within an interactive session. A fully-headless mode is not a v1 promise.

**Why.** These are the levers that make one unchanged project usable across models and let the
user understand and steer harness behavior without editing the project.

---

## 11. Console UX & history navigation (best-effort, bounded by Pi)

**What.** **Recognizable, not identical.** Add custom renderers for the Claude-specific concepts
that matter — subagent dispatch and **inspecting a subagent's output**, skill activation, tool
calls — and a reasonable, familiar-feeling set of message-history navigation features.

**What we do NOT do.** Rebuild Claude Code's console wholesale or chase 1:1 parity. We inherit and
extend Pi's TUI rather than fight or replace it.

**Why.** Familiarity reduces friction when switching between Claude Code and PiClauDex, but UX
parity is an open-ended sink; bounding it as best-effort keeps it from consuming the project.

---

## 12. Non-functional requirements (with acceptance bars)

### 12.1 Token efficiency = mechanical fidelity of loading (verified)

Progressive disclosure is a hard, tested requirement, not a "looks similar" claim: skill
name+description at startup; body only on activation; bundle files only when read; description
listing honors its budget. **Acceptance:** tests assert the body/bundle content is **absent** from
context before activation. Fan-out size and subscription fit are the project author's concern
(§8).

### 12.2 Performance & parallelism

Worktree creation latency is bounded; parallel sessions on separate worktrees run concurrently
without interference; subagent fan-out honors a configurable concurrency limit. Reasoning-model
latency is inherent and not something we mask.

### 12.3 Cross-platform & Windows mechanics

The harness runs natively on **Windows 11 and Linux**. It honors the `shell:` field and runs both
**bash and PowerShell** for hooks and skill injection. **Boundary:** where a *project* assumes
bash (as DemonMatrix's `dm-*.sh` do, even on Windows), we require bash present (Git Bash on
Windows) — that is the project's assumption, not something the harness can paper over. Path
canonicalization across Windows path namespaces is handled in the worktree/hook layers; long paths
and best-effort worktree removal are Windows-aware (§4.4).

### 12.4 Observability & debuggability

Because behavioral fidelity is uncertain, the harness must make it **diagnosable why a fan-out or
routing decision went the way it did** — transcripts/event streams that let the user inspect
subagent inputs/outputs and tool calls. This is a first-class NFR, not an afterthought.

---

## 13. Behavioral fidelity & steering

### 13.1 Expectation

Models differ; exact behavioral equivalence is impossible and accepted. The **mechanical** tier
(§2.1) must match; the **behavioral** tier is best-effort.

### 13.2 Model-steering layer

A harness-side, **project-external** place to inject per-model system-prompt guidance that nudges
GPT toward Claude-like behavior (e.g. how to honor locked-output contracts, fan-out discipline).
The harness never edits the project to achieve this. The user may separately choose to adjust a
project's skill wording, but that is **out of scope for harness development** — the standing goal
remains "runs unchanged."

**Done when.** Per-model guidance can be configured and demonstrably changes model behavior on the
reference workflow without any project edit.

---

## 14. Testing & example-project strategy

**What.**
- **Unit tests first**, covering each subsystem's field/behavior matrix — including fields and
  paths **DemonMatrix does not exercise** (the tier-up completeness bar, §2.2).
- **Integration tests** against **purpose-built example `.claude/` fixture projects** that each
  exercise a full feature surface (nested subagents, path-scoped rules, `@import`, worktree
  seeding via `.worktreeinclude`, hook events, installed-plugin content, etc.), plus the
  DemonMatrix end-to-end run as the headline conformance test.
- **NFR verification tests** (lazy-load absence assertions, compaction re-injection,
  cross-platform execution).

**Why.** "Complete and conformant" is only credible if proven; fixtures make generality testable
independently of the one reference project and guard against regressions as Claude Code evolves.

---

## 15. Success criteria (acceptance for v1)

1. **DemonMatrix end-to-end** on GPT/Codex, unchanged: a full container flow (plan → implement →
   collaborate → merge), including worktree isolation and a description-matched review fan-out
   returning verbatim payloads, and `/merge` with Windows-tolerant reap.
2. **Two parallel containers** in separate worktrees under (optionally different) models, without
   interference.
3. **Fixture conformance:** each fully-functional subsystem passes its fixtures, including
   non-DemonMatrix fields/paths.
4. **NFRs verified:** progressive disclosure (asserted), compaction re-injection, cross-platform
   (Win + Linux) execution.
5. **Compatibility report** correctly names degraded/deferred features for a project that uses
   them.
6. **Dogfood (secondary signal):** PiClauDex's own growing `.claude/` corpus runs under PiClauDex
   with a GPT model, unchanged.

---

## 16. Non-goals (consolidated)

- 100% Claude Code parity or console look-and-feel parity.
- The interactive permission model, permission modes, and auto-mode classifier (§6).
- Plan mode and `AskUserQuestion` (§7).
- MCP, agent teams, background agents, scheduled tasks, remote control, LSP, computer use,
  Artifacts (§7).
- Plugin **installation** and marketplace machinery (we load installed plugins' content — §4.9).
- Auto-memory/persistent agent memory as a functional store (§7).
- Mid-flight handoff of a live worktree/session between Claude Code and PiClauDex (compatible-but-
  independent only — §2.5).
- Changing the target project to make it run (§2.3).
- Deciding or capping a project's fan-out/subscription economics (author's concern — §8).

---

## 17. Forward-compatibility & maintainability

Claude Code will evolve; the harness must be updatable without re-architecture, and must clearly
record what is and is not supported.

**What.**
- **Versioned baseline.** All support claims are relative to a named Claude Code baseline
  (~v2.1.x, mid-2026). Features added upstream after the baseline are **unassessed** until
  reviewed.
- **A single living capability registry** — the source of truth — enumerating every known Claude
  Code artifact, frontmatter field, tool, hook event, and setting, each tagged
  `Full | Partial | Degraded-noop | Not-supported | N/A` with a one-line note. This is the
  "carefully documented what's supported / what's explicitly not," in an updatable form.
- **No drift.** The runtime compatibility report and `/doctor` (§6.2) are **generated from** the
  registry, so documentation and actual behavior cannot disagree.
- **Forward-compatible by default (§2.4).** Unknown fields/keys/tools/events degrade safely and
  are surfaced as "unrecognized/unassessed," so a project using a future feature still runs
  (minus that feature).
- **Repeatable re-assessment.** The gap-analysis sweep used to build this plan becomes a periodic
  process; upstream changes are folded into the registry against the baseline version with a
  changelog. Adding support for a newly-assessed feature is a registry update + targeted
  implementation, not a redesign.

**Why.** Without an explicit, versioned, drift-free record and safe handling of the unknown, the
harness silently rots as Claude Code moves and the user cannot tell what will or won't work.

**Done when.** The registry covers the baseline surface and drives the compatibility report;
introducing an unknown field/tool/event in a fixture degrades safely and is reported as
unassessed; the registry is updatable as a data change.

---

## 18. Base-harness assumption

PiClauDex is built on **Pi** (`earendil-works/pi`, MIT, TypeScript). Whether we **fork** Pi or
**depend on the published package + ship extensions** is a HOW decision deferred to a design
document; the recommendation to start with depend-plus-extensions (and fork only if we hit a wall)
is noted but not settled here.

---

## Appendix — topic coverage checklist

Purpose (§1) · Two-tier fidelity (§2.1) · Completeness floor + tier-up (§2.2) · No project changes
(§2.3) · Forward-compatible-by-default (§2.4) · Interop model (§2.5) · Verify-NFRs (§2.6) ·
Discovery/precedence (§3) · Skills (§4.1) · Rules (§4.2) · Agents & subagents incl. recursion &
isolation (§4.3) · Worktrees incl. `.worktreeinclude` (§4.4) · Hooks full event set (§4.5) ·
CLAUDE.md incl. `@import` (§4.6) · Slash commands/args (§4.7) · Tool-surface parity incl.
Web tools (§4.8) · Installed-plugin content (§4.9) · Settings & toggles (§5) · Security posture &
compatibility report (§6) · Deferred/degraded subsystems (§7) · Auth & quota (§8) · Compaction
(§9) · Control surface & steering (§10, §13) · Console UX/navigation (§11) · NFRs: token/lazy-load,
performance, cross-platform, observability (§12) · Testing & fixtures (§14) · Success criteria
(§15) · Non-goals (§16) · Forward-compatibility & capability registry (§17) · Pi base (§18).

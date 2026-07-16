# Changelog

All notable changes to PiCC are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/), and the project aims to follow
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Changed — Read denies gate the whole read family (2026-07-16)

- **A `deny: Read(<glob>)` rule now also blocks `Grep`, `Glob`, and `NotebookRead` on a matching
  path**, not just the `Read` tool — closing a parity/security gap where a denied path stayed fully
  readable through the other built-in file-read tools. This mirrors Claude Code's best-effort model
  of applying `Read` rules across its file-reading tools (`Grep`/`Glob` are documented parity;
  `NotebookRead` is included as inferred defense-in-depth). The expansion is one-directional — a
  `Grep(<glob>)` rule does not gate `Read` — matching the existing edit-family behavior. Honest
  limit: matching is on the call's path argument, so a read with no path (or `path: "."`) is not
  caught; only a bare `deny: Read` (which removes the read tools from context) forecloses that.

### Fixed — "verbatim final message" contract documented accurately (2026-07-16)

- The capability registry and design docs claimed a subagent's final message is returned "verbatim
  (no wrapper)." That was inaccurate for **resumable** dispatches, which append a clearly-delimited
  in-band identity/resume trailer to the model-visible text (faithful to Claude Code, which appends
  the same kind of resume handle to resumable subagent results; the human TUI strips it). The docs now state
  the real contract — verbatim for non-resumable/one-shot dispatches, verbatim plus the delimited
  identity trailer for resumable ones — so an exact-token / JSON / YAML consumer knows the shape.
  **Behavior is unchanged**: this is a documentation-truthfulness fix (a downsize of #46; the proposed
  separate identity channel was deliberately not built — rationale in
  `doc/plan/26-verbatim-contract-docs/feature.md`).

### Added — collaborative planning posture by default (2026-07-16)

- **PiCC's always-on conventions block now carries a short collaborative-planning nudge, so a
  GPT/Codex model adopts a more Claude-Code-style planning posture by default.** On a substantial
  planning or exploration request the model is nudged to ground itself by reading the repo,
  resolve discoverable facts instead of asking about them, ask only about goals, preferences, and
  material tradeoffs, surface meaningful alternatives and recommend one, and avoid collapsing a
  planning phase into a restatement of the request followed immediately by "go"/"confirm" — while
  still implementing decisively and autonomously once scope is agreed, and still honoring a skill's
  explicit approval gate. **Why you'd care:** it narrows the visible interaction-quality gap between
  Claude Code-authored and PiCC-authored sessions on the same skill, so a Claude-authored workflow
  like `implement-feature` is nudged to engage before confirming instead of short-circuiting to a
  "go" prompt.
  It applies to every project run under PiCC, not just this one, and is a best-effort prompt nudge —
  outcome is model-dependent (guidance, not enforcement); it is not Plan mode, not the
  `AskUserQuestion` UI, and not a deterministic conversation state machine. The lever if you want a
  different interaction style is the existing per-model `steering` config, which layers on top of the
  built-in default (see the user guide) — a contrary steering entry can, for example, tone the
  posture back toward terse, minimal-question turns.

### Changed — description-based feature naming (2026-07-15)

- **Future `implement-feature` runs use one concise descriptive slug instead of allocating a global
  feature number.** The slug consistently names the worktree, `feature/<feature-slug>` branch, plan
  folder, headings, and commit prefix, with portable validation and collision checks. A linked GitHub
  issue number remains the canonical numeric reference; task ordering remains local (`t01`, `t02`, …).
  Legacy numbered feature runs and historical artifacts keep their established identities unchanged.

### Fixed — collection-aware background settlement delivery (2026-07-15)

- A terminal record successfully returned by `TaskOutput` now counts as delivery, suppressing the
  redundant not-yet-sent next-turn settlement notice. Running polls still preserve notice eligibility,
  and eligible uncollected current tasks still receive one bounded notice; post-notice retrieval
  remains available without re-arming another notice.

### Added — evaluate skill (2026-07-15)

- **A new `evaluate` skill rates a GitHub issue, a proposed (not-yet-filed) issue, or a pull request
  and drives a disposition — invocable by a human (`/evaluate <target>`) or by another agent.** One
  shared evaluation engine backs **three modes**, auto-routed (the human never picks): **issue-eval**
  (understand an open issue and act — a confidence-gated close of clear slop with a canned comment, or
  a keep-open rating comment, biased to keep-open when uncertain), **proposal-gate** (score a would-be
  issue with **no GitHub write** at all), and **pr-eval** (assess a PR's diff, whether it fulfils its
  ticket and whether the ticket was worth doing, and the verification evidence, then post an advisory
  assessment comment — **it never merges**). Every mode weighs the target against named criteria (user
  value, reach, legitimacy incl. a slop/malicious screen, clarity, blast radius, conflict,
  cost-vs-benefit) and shows its reasoning in the posted comment.
- **A fixed action envelope, previewed and confirmed before every public write.** The skill's entire
  set of GitHub writes is: confidence-gated close + canned comment, keep-open rating comment, PR
  assessment comment, and verification-request comment — it never merges, edits, labels, reopens, or
  locks. It always previews the rating and the exact write and asks for the human's explicit go before
  any close or comment; there is **no unattended/autonomous mode and no `--yes` token**. Honest scope:
  on the structural surfaces the no-write guarantee is absolute (a tool-gated agent *cannot* perform
  the write); on the coordinator's own path it rests on a defence-in-depth `settings.json` deny floor
  plus the text-is-data discipline, because in PiCC `allow`/`ask` rules are no-ops (only `deny` and
  per-agent tool-gating are hard).
- **Every agent that ingests attacker-controlled target content is a shell-free, read-only sandbox.**
  The maliciousness screen, proposal-gate, and all roaster/pro-con/lens reviewers run as one dedicated
  `evaluator` agent with no shell, write, fetch, or dispatch tools, so they *cannot* post, close, run a
  reproducer, fetch a link, or fan out. The Bash-capable coordinator does all `gh` work but **redirects
  raw issue/PR body, comments, and diff to a temp file it does not read**, resolving only bounded
  non-body metadata (issue-vs-PR, open/closed, changed-file list, CI status) via targeted `--jq`
  queries — so no attacker text reaches a shell-capable agent, and the coordinator operates on the
  evaluator's constrained outputs, not raw bytes. **Honest limit:** the coordinator's non-ingestion is
  a *disciplined redirect* (behavioral), not a tool-enforced block. The `gh … > file ⇒ empty stdout`
  premise is smoke-tested and confirmed (Windows Git Bash + PowerShell); correctness also requires the
  redirect produce UTF-8 (Bash-tool `>`; a PowerShell `>` writes UTF-16LE the evaluator's Read cannot
  decode).
- **Malicious input is contained, and re-runs are idempotent.** The screen classifies the target into
  a fixed category set and nothing else, so an injection can at most flip the category, never smuggle
  an instruction; parsing fails safe to keep-open. **Invariant: a close always carries the canned,
  category-selected comment (which contains none of the target's text); only a keep-open ever carries
  a model-authored rating** — so attacker text can never ride a destructive action. A second
  evaluation of the same target does not double-post or double-close (already-closed/already-commented
  targets short-circuit via a metadata-only scan). Prose-only — no `src/` change; a defence-in-depth
  `.claude/settings.json` deny floor is added.

### Changed — implement-feature proposal-gating & verification guidance (2026-07-15)

- **`implement-feature`'s Phase 8 issue-filing offer now runs the `evaluate` proposal-gate on each
  machine-surfaced finding.** Clear slop is dropped with a one-line tally (so nothing vanishes
  invisibly), and the rest are surfaced with the assessment embedded and **per-item user choice
  preserved** — the gate subtracts clear slop, never the user's own call.
- **The Phase 1 ticket-creation offer is annotated, never gated.** When the skill offers to file the
  human's own just-converged feature, proposal-gate gives an **in-session value advisory** before
  filing; it is **never** baked into the public issue body and **never** suppresses the human's offer.
- **The PR hand-off now produces concrete, applicability-aware verification guidance** instead of a
  generic "verify in the running app" prompt. The coordinator first judges whether the change warrants
  manual verification (docs-only or fully-auto-tested → "no manual verification needed: `<reason>`";
  but a skill/harness/prose change **is not** exempt — picc executes it) and, where it does, gives
  concrete branch/launch/in-app steps and the observable outcome. This threads with `handoff.md`'s
  existing "no runnable UI → picc executing the changed behaviour" doctrine rather than contradicting
  it.
- **`CONTRIBUTING.md` and a new `.github/pull_request_template.md` now demand and explain the same
  verification contract.** Both name the **two artifacts** (verification *guidance* in the PR
  description; a **manual-verification comment** as the author's evidence), carry the applicability
  escape prominently so docs-only / fully-auto-tested changes are never nagged, and CONTRIBUTING adds a
  worked cross-platform example (Windows Git Bash + Linux) launching picc against an `examples/`
  fixture. The same concrete + applicability-aware standard governs pr-eval's enforcement and
  implement-feature's own creation-side guidance, so all three surfaces tell one consistent story.

### Added — `subagent_type: "fork"` parent-conversation inheritance (2026-07-15)

- **The `Agent`/`Task` tool now supports `subagent_type: "fork"` — a subagent that inherits the
  parent conversation instead of starting fresh.** A fork starts with the parent (main-session)
  message history already in context and runs with the parent's model and tools, so a Claude-authored
  project that hands a side task to a fork *expecting it to already know the whole situation* now
  behaves faithfully. **Output isolation is kept** — only the fork's final result returns; its
  intermediate steps stay out of the parent conversation. Previously a `"fork"` dispatch fell through
  the unknown-type fallback and ran as a fresh-context `general-purpose` agent — with only a generic
  "unknown subagent_type" warning, so the loss of fork semantics itself went unsignalled (the opposite
  of fork semantics, and subtly wrong rather than an error).
- **Gated by `CLAUDE_CODE_FORK_SUBAGENT`** — `1` forces inheritance on, `0` (or any off value) forces
  an explicit visible degrade, and **unset ⇒ enabled** (a deliberate PiCC parity choice over Claude's
  under-specified staged-rollout default). The inherited parent model is still overridden by an
  operator `CLAUDE_CODE_SUBAGENT_MODEL` env and by a per-call `model` argument.
- **Honest, visible degrades instead of a silent semantic inversion.** Fork inheritance is honored
  only for a **main-session** dispatch; when a `"fork"` can't inherit — env off, a nested (non-main)
  dispatcher, print/headless/no-session (no parent transcript), a fork trying to spawn another fork,
  or an SDK that can't fork — it runs with fresh context **and** surfaces a specific footer notice
  (never the generic "unknown subagent_type" warning), toned calmly for by-design cases and as a
  warning for genuine can't-do cases. A fork is **non-resumable** (`SendMessage` refuses it) and a
  fork **cannot spawn another fork**.
- **Disclosed limits (advertised truthfully at registry tier `partial`, `tool.Agent.fork`):** the
  fork's system prompt is a same-context **reconstruction**, not a byte-identical copy (PiCC is an
  extension on a Pi-assembled base prompt), so a fork forgoes the prompt-cache cost saving a real fork
  gets; print/headless support, the fork-mode `run_in_background` removal, and `isolation: "worktree"`
  on a fork are not adopted (PiCC keeps `run_in_background: false` as a synchronous selector and relies
  on background-by-default for the rest); PiCC deliberately does not reproduce Claude's interactive
  named-fork zero-context regression (anthropics/claude-code#76019). The capability matrix, research
  internals doc (§2.9), README, user-guide, architecture, and design docs were updated, and
  `doc/supported-features.md` was regenerated from the registry. Closes #28.

### Added — real cell-based `NotebookRead` (2026-07-15)

- **`NotebookRead` is now a real tool that reads a Jupyter notebook (`.ipynb`) cell by cell**,
  replacing the old degraded no-op that just pointed the model at the raw notebook JSON. Each cell is
  presented with its index, type (code / markdown / raw), source, and — for code cells — its outputs
  (stream text, `text/plain` and other text reprs, and error tracebacks), so a Claude-authored project
  that touches notebooks gets usable structure instead of a wall of base64/metadata cruft. This closes
  the **reading** half of the notebook parity gap.
- **Tier is `partial`.** Image outputs are **noted, not rendered** visually — raster images
  (`image/png`/`jpeg`/…) by mime-type with an approximate (base64-length) size, and other binary or
  structured outputs (SVG, `application/json`) by mime-type only. This is a permanent design choice
  (PiCC targets text-oriented GPT/Codex models). Oversized text outputs are head-truncated rather than
  dumped into context. Single-cell selection (`cell_id`) is not currently supported — a scope cut, not
  a permanent non-goal.
- **Reach for `NotebookRead`, not `Read`, on a `.ipynb`.** PiCC's inherited `Read` tool does not
  special-case notebooks, so `Read` on a `.ipynb` still returns the noisy raw JSON; `NotebookRead` is the
  cell-based path. Worth knowing when debugging why a notebook read looks noisy.
- **`NotebookEdit` remains a separate, larger follow-up** — it stays a degraded no-op (cell insert /
  replace / delete and execution-count handling are out of scope here).

### Added — real MultiEdit tool (2026-07-15)

- **`MultiEdit` is now a real tool instead of a degraded no-op.** It takes a `file_path` and an array
  of `{ old_string, new_string, replace_all? }` edits and applies them **sequentially and atomically**
  to one file: each edit operates on the result of the previous one, matching is exact-string (an
  `old_string` that is absent — or ambiguous without `replace_all` — is an error), an empty `old_string`
  on the first edit of a new file creates it, and if **any** edit fails the whole batch is rejected and
  the file is left untouched. Previously every `MultiEdit` call returned a notice telling the model to
  fall back to a sequence of `Edit` calls, losing the all-or-nothing guarantee. It routes through the
  same permission, hook, and path-scoped-injection machinery as `Edit`, and is grantable to subagents.
- **Note — posture change:** because `MultiEdit` graduated from a no-op to a *real writer*, a project
  can no longer treat MultiEdit-degradation as an implicit safety net. Its `Edit`/`MultiEdit` deny rules
  are what hold — and an `Edit(…)` deny rule already covers `MultiEdit` (the file-edit family), so no
  settings change is needed to keep an existing `Edit(…)` restriction effective.
- **Registry + docs re-tiered.** `tool.MultiEdit` moves from `degraded-noop` to **full**, with an honest
  note that the pinned Claude Code 2.1.x baseline itself no longer ships MultiEdit (removed in the 2.0
  line) — so `full` means faithful to the pre-removal contract, kept as an older-project compatibility
  courtesy. `doc/supported-features.md` was regenerated from the registry.

### Added — richer git commit messages by default (2026-07-15)

- **PiCC's always-on conventions block now carries a short commit-message nudge, so a
  GPT/Codex model writes richer commit messages by default.** When the model is asked to
  commit, it is nudged to first read the changes (`git status`/`diff`) and the recent
  `git log`, match the repository's established commit-message style where that style is
  richer, and — for a non-trivial change — include a short body explaining *why* the change
  was made, not just what. **Why you'd care:** it narrows the visible quality gap between
  Claude Code-authored and PiCC-authored commits on the same repo, so a repo's history stays
  more consistent no matter which harness drafted the commit. This is a best-effort prompt nudge
  that *approximates* Claude Code's commit quality — outcome is model-dependent, it does not
  reproduce Claude Code's full commit ceremony (no HEREDOC commit form, no attribution
  trailer, no parallel git batching), and it changes nothing about attribution
  (`includeCoAuthoredBy`). The existing `git commit --no-verify` prohibition is preserved.
  It applies to every project run under PiCC, not just this one. The lever if you want
  different behavior is the existing per-model `steering` config, which layers on top of the
  built-in default (see the user guide) — a contrary steering entry can, for example, tone a
  commit message back down to a terse subject-only line.

### Changed — background-by-default subagent dispatch (2026-07-14)

- **Subagent dispatch (`Agent`/`Task`) now runs in the background by default, matching Claude Code
  2.1.198+.** A dispatch that omits `run_in_background` returns a task id immediately and runs
  concurrently with any other dispatch issued in the same turn, so a Claude-authored implicit-concurrency
  fan-out (dispatch N reviewers in one turn, collect the results) **parallelizes** instead of silently
  serializing; terminal results are collected via `TaskOutput`, while `TaskStop` stops a run. An eligible
  current task that remains uncollected and unnotified receives one bounded settlement notice on the
  next turn. Pass **`run_in_background: false`** to run a dispatch synchronously
  and return its result inline in the same turn. An agent's `background: true` frontmatter still forces
  background (even against an explicit `run_in_background: false`), and
  `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS` still forces **every** `Agent`/`Task` dispatch to the
  foreground (the serial-again escape hatch); `SendMessage` resume is inherently async and is not
  governed by that switch.
- **Nested (depth ≥ 2) background fan-out is now concurrency-bounded.** A sub-coordinator dispatching
  many agents in one turn no longer spawns an unbounded number of concurrent sessions: each depth has
  its own `concurrency`-sized budget (total ≤ `maxDepth × concurrency`), and a parent blocked collecting
  a child does not deadlock. This is a deliberately conservative, finite, deadlock-free PiCC choice that
  diverges from Claude's single global (~10) parallel-agent cap — not exact parity.
- **Registry + docs re-tiered to tell the truth.** `tool.Agent`/`tool.Task` stay **partial**, but the
  divergence is no longer "PiCC defaults foreground" — residual settlement timing remains: PiCC pushes
  eligible notices next-turn, while reporter observations describe active-conversation notification but
  establish no exact normative timing. The `feature.background-agents` "defaults foreground" gap is
  removed and `agent.frontmatter.background` is reworded to "forces background". The
  README, user-guide, architecture, and design docs were corrected, and `doc/supported-features.md` was
  regenerated from the registry.
### Added — fork-aware hand-off and on-the-fly ticket creation for implement-feature (2026-07-14)

- **`implement-feature` now offers to open a GitHub issue when it was invoked without a ticket.** After
  the Phase 1 scope mirror converges, and only when GitHub is reachable, the skill previews a
  model-authored issue capturing the agreed WHAT/WHY and offers — opt-in, as its own yes/no exchange
  distinct from the build "go" — to file it. On acceptance the issue is filed (its URL echoed) and the
  run continues **on the ticket path exactly as if the ticket had been given up front** — branch, plan,
  build, then a pull request and one hand-off comment. Declining keeps the plain ticketless flow. The
  **maintainer ticket-path hand-off (auto-PR + hand-off comment) is unchanged**; the **maintainer
  ticketless run is unchanged up to the new offer** and, only if that offer is accepted, gains ticket
  reads/writes and an auto-PR. The ticketless path now carries **two** opt-in GitHub offers:
  create-ticket after the scope mirror, and file-findings at close.
- **`implement-feature` now works from a fork the contributor cannot push to.** The coordinator
  resolves the upstream *target* repo (where issues live and the PR is based) separately from the
  *fork* it can push to; every ticket read/write targets the upstream, only the branch push targets the
  fork. At hand-off on a fork it pushes the branch to the fork and hands over a ready-to-click compare
  URL plus a paste-ready PR title and body (and an optional paste-ready comment), so the user opens the
  PR against the upstream through GitHub's web UI — where the upstream's PR template, CONTRIBUTING
  checklist, and any CLA/DCO gate surface. **No PR or comment is auto-created on a repo the user does
  not own**; the only automatic GitHub write on a fork run is the branch push. Cross-repo linking is
  kept safe: a closing keyword is emitted only when the resolved issue lives in the repo the PR targets,
  otherwise a bare cross-repo reference — so an upstream PR never wrongly closes the target's own
  same-numbered issue.
- **The skill was reorganized on disk into a slim always-loaded router plus on-demand reference files**
  (prose only — no `src/` change). Beyond trimming per-run context, this **fixes silent
  post-compaction truncation**: the pre-split body exceeded PiCC's 20,000-character per-skill
  re-injection cap, so after a compaction the later phases and templates were dropped from the resident
  copy and the workflow proceeded without them. The slim router now stays under the cap and survives
  intact, with the detail re-read on demand; the write-discipline floor stays resident so public writes
  are never made with the rules unloaded.

### Fixed — subagent TaskOutput/TaskStop scoped to the dispatcher's own tasks (2026-07-14)

- **A subagent's `TaskOutput` and `TaskStop` now reach only the background tasks that same subagent
  dispatched.** A task dispatched by a sibling subagent or by the coordinator is unreachable: the
  subagent is refused cleanly, with no read of, or effect on, the foreign task's result or status, and
  the refusal does not reveal that the id exists elsewhere in the session. The coordinator is
  unaffected and retains full access to every task. This closes a cross-dispatcher isolation gap in the
  session-wide background-task registry. The capability registry's inverted parity note — which wrongly
  claimed Claude hides `TaskOutput` from subagents while PiCC's session-wide registry exposes every task
  — is corrected: subagents *inherit* `TaskOutput`/`TaskStop` per Claude's sub-agents documentation, the
  "hidden TaskOutput" behavior is a filed Claude bug (#15098, #23154), and PiCC's explicit per-dispatcher
  guard is an honest hardening that is stricter than Claude only on the #15098 coordinator-passed-id edge.

### Added — SlashCommand tool (2026-07-14)

- **`SlashCommand` is now a real, working tool instead of a degraded no-op.** A model can call
  `SlashCommand({ command: "/name args" })` to run a custom command mid-conversation: PiCC parses the
  leading `/name` (optional slash; plugin-namespaced `/plugin:name` allowed), resolves the skill, and
  activates it with the trailing text as its arguments — identical to the `Skill` tool for the same
  skill+args. Skill semantics are honored the same way (a `disable-model-invocation` skill is refused,
  a `context: fork` skill runs forked and returns its result, a byte-identical re-invocation dedups),
  model-invocability matches the `Skill` tool (a `user-invocable: false` model-only skill still
  activates; only `disable-model-invocation` blocks), and the tool is grantable to subagents, carrying
  dispatch depth into forked skills. Both tools now delegate to one shared skill-activation closure, so
  the `Skill` tool's behavior is unchanged. The capability registry retiers `tool.SlashCommand` from
  **degraded-noop** to **partial** (it covers all user-defined skills/commands but not the built-in
  commands Claude 2.1.x also exposes on the Skill/SlashCommand skill-activation path — `/init`,
  `/review`, `/security-review` — which PiCC does not ship); `doc/supported-features.md` was
  regenerated from the registry.
- **Operator note:** `SlashCommand` is a second, independently-gateable route to model-driven skill
  activation alongside `Skill`. Both honor each skill's `disable-model-invocation` and
  `disallowed-tools`, but a project that wants to block model-driven skill activation via
  `permissions` must gate **both** tool names, not just `Skill`.

### Fixed — context: fork failure preservation and Esc abort (2026-07-14)

- **A `context: fork` skill that fails partway through no longer silently loses its work or crashes.**
  A fork that dies on a terminal error is now a **loud failure that names the cause and preserves the
  partial output** it produced before dying, inside the same cut-off frame the `Agent` tool uses —
  bringing the fork path to parity with the subagent error contract (Claude 2.1.199). This was the
  last place the silent-loss/empty-success class of defect survived on the subagent surface. Under the
  hood the `Agent` tool and every fork consumer now render outcomes through one shared
  `presentDispatchResult` helper. Pressing **Esc** now cancels an in-flight fork and reports it as
  **aborted** rather than an empty success or a crash — a model-invoked fork (the `Skill` or
  `SlashCommand` tool) via Pi's per-call abort signal, and a *typed* top-level `/forked-skill` in
  interactive mode via the input hook watching raw terminal input for Esc (print/RPC modes have no
  Esc). Fork dispatches stay non-resumable.

### Fixed — defensive background-task error storage (2026-07-14)

- Resolved failed and aborted background dispatches now retain only bounded, single-line error text
  at the task-registry boundary. Whitespace and Unicode `Cc` control-character runs are normalized and
  oversized errors are capped, preventing future dispatch callers from bypassing the existing
  defense-in-depth handling on user-visible and model-facing failure paths.

### Added — GitHub ticket integration for implement-feature (2026-07-14)

- **`implement-feature` can now be invoked with a GitHub issue reference (`#5`, `5`, or an issue URL)
  and wire the whole cycle to that ticket.** With a ref present the skill scopes the Phase 1 direction
  conversation from the issue (title, body, labels, and comments read via `gh`) and, at hand-off, opens
  a ready-for-review pull request linked to the ticket (on a pushable target — F12 makes this
  fork-conditional; `Closes #N` when the work fully delivers the ticket, a bare `#N` when it only partly
  does) and posts **one** comment on the issue explaining what was built and how the application's
  behaviour changes. Nothing is posted to the ticket before hand-off.
  The two hand-off artifacts are written for their audiences: the PR body is a *"Start your review
  here"* guide to verifying the change in the running app, while the issue comment speaks to the
  ticket's readers. At close — on either the ticket or the ticketless path — the skill also **offers to
  file surfaced out-of-scope findings** (unfixed bugs, improvements) as GitHub issues, per-item and only
  with explicit approval. The change stays **essentially additive**: invoked with no argument the skill
  does no ticket reads and no auto-PR (unless the create-ticket offer added in F12 above is accepted),
  and the issue-filing offer is opt-in and appears only when GitHub is reachable. Failure handling is **honest** — a missing or unauthenticated `gh`, an unreadable issue,
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
- **Background settlement push.** When the latest generation of a background dispatch settles and
  remains uncollected and unnotified, the coordinator receives one bounded, untrusted-framed notice at
  its next turn. Terminal `TaskOutput` collection now suppresses a not-yet-sent notice; running polls
  preserve eligibility. `background: true` agent frontmatter (Claude 2.1.198) is honored, routing
  through the same background lifecycle.
- **Per-subagent usage accounting.** Token/cost usage is recorded with each dispatch result, in the
  transcript, and in a new **`/usage`** control command (per-subagent breakdown + a subagents
  total). `/usage` is **subagent-scoped only** — a PiCC-additive surface, not Claude Code's
  whole-session `/usage`/`/cost` (the Pi extension API exposes no parent-session cost).

### Changed — registry truthfulness (2026-07-13; historical, superseded by F15)

- At the time of this entry, the capability registry was updated to match the then-shipped behavior:
  `tool.Agent`/`tool.Task` were downgraded to **partial** because PiCC still defaulted dispatches to
  the foreground while Claude 2.1.198 ran subagents background-by-default. **F15 subsequently closed
  that default-direction gap: PiCC now dispatches background-by-default.** This historical update also
  added `tool.SendMessage` (partial) and `agent.frontmatter.background` (full), documented the
  then-current settlement push in `feature.background-agents`, corrected `tool.TaskOutput`/
  `tool.TaskStop`, `hook.event.SubagentStart`/`SubagentStop` (agent_id + agent_type;
  `transcript_path` stays MAIN), and `hook.event.Notification` (settlement fires no
  `agent_completed`) notes, downgraded `setting.cleanupPeriodDays` to **partial** (worktrees only —
  no subagent-transcript reaper), and regenerated `doc/supported-features.md`.

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
- **Auto memory**: project `MEMORY.md` (first 200 lines / 25 KB) loads at session start;
  `autoMemoryEnabled`, `autoMemoryDirectory`, `CLAUDE_CODE_DISABLE_AUTO_MEMORY`. Agent
  `memory: user|project|local` frontmatter also injects per-agent memory. Writes are conservative
  by default — memory is written or updated only when you explicitly ask it to remember something,
  a deliberate divergence from Claude Code's proactive write-back; loading is unchanged and no
  setting was added. Opt into eager, Claude-Code-style writes per project via `CLAUDE.md`.
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

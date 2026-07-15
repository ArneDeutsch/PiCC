# t03: Capability registry, research §, docs, CHANGELOG, matrix regen

## Goal

The Task-tool `subagent_type: "fork"` capability is **truthfully advertised** at tier
**`partial`**: the capability registry gains a dedicated entry describing the
implemented inheritance semantics **and its honest limits**; the internals research
doc gains a section the registry `§`-reference resolves to; every existing doc that
now states something F16 makes false or incomplete is corrected; the generated
capability matrix is regenerated; and CHANGELOG reflects the new behavior.

## Context & seams

### Capability registry — `src/registry/capability-registry.ts`

Entries are `cap(kind, id, tier, note, optionalFlag?)`, `tier ∈ {full, partial,
degraded-noop, not-supported}`. Tool entries in `TOOL_ENTRIES` (~`:40-79`);
`tool.Agent`/`tool.Task` at ~`:49-50`; `tool.SendMessage` at ~`:78`;
`feature.background-agents` at ~`:232`; the skill `context:fork` entry at ~`:173-204`
(a **different** meaning of fork — do not conflate). **Notes must be a single line**
(`test/registry.test.ts:143` rejects `\n`) and separate **verified** from **INFERRED /
PiCC-defined** claims (house style: `tool.TaskOutput` note at ~`:76`). Ids are
free-form strings, so `tool.Agent.fork` (two dots) is fine — no flat-form fallback
needed.

- Add a dedicated entry `tool.Agent.fork`, tier **`partial`** (NOT `full`): the
  feature defers documented edges — print/headless support, `run_in_background`
  removal, `isolation:"worktree"`, and nested-dispatcher inheritance — and the system
  prompt is a reconstruction, so `partial` is the truthful tier. The single-line note
  must state: inherits parent conversation (full history) + parent model + parent
  tools; **output isolation kept**; **main-session dispatch only** (nested dispatchers
  visible-degrade); system prompt is a **same-context reconstruction, not
  byte-identical** (so it **forgoes the prompt-cache cost saving** a real fork gets);
  `CLAUDE_CODE_FORK_SUBAGENT` gate (`=1` on / `=0` explicit visible degrade / **unset ⇒
  enabled**, a PiCC parity choice over Claude's under-specified staged-rollout default
  — and note the divergence is *directional*: PiCC may inherit where a staged-rollout
  Claude with fork unset would run fresh); model inheritance respects an operator
  `CLAUDE_CODE_SUBAGENT_MODEL` override **and a per-call `model` argument on the
  `"fork"` dispatch** (both override the inherited parent model — disclose both so the
  "same model as parent" claim stays truthful); **non-resumable**; **a fork cannot spawn
  another fork** (visible refusal — INFERRED mechanism); **print/headless/no-session
  forks degrade** (no parent transcript); **fork-mode's `run_in_background` removal is
  NOT adopted** — PiCC keeps `run_in_background:false` as a synchronous selector
  (relying on F15 background-by-default for the "all background" half); `isolation:
  "worktree"` on a fork **not honored**; the Claude version gate (v2.1.117+) is not
  mirrored; a `name` does not affect inheritance and PiCC does NOT reproduce the
  interactive named-fork zero-context regression (`anthropics/claude-code#76019`).
  Reference the new research `§` (below).
- Add a one-clause cross-reference to `tool.Agent.fork` in `tool.Agent`, `tool.Task`,
  and `feature.background-agents`.
- **Reword `tool.SendMessage` (~`:78`)**: it currently says "fork/agentOverride
  dispatches … are unsupported" — technically true (forks are non-resumable) but next
  to a `partial` fork entry it reads as a contradiction. Change to "fork dispatches are
  **non-resumable** (inherited context can't be re-derived)" and cross-reference
  `tool.Agent.fork`.

### Research doc — `doc/research/02-claude-code-internals.md`

- Add a section (suggested **§2.9 "Fork the current conversation"** — §2.8
  "Skills vs subagents" is currently last, so 2.9 is free and the registry `(§2.9)`
  resolves): documented Claude semantics (inherit history/system-prompt/tools/model,
  output isolation, shared prompt cache, `run_in_background` removal side effect), the
  env gate, the fork-cannot-spawn-fork rule, and **PiCC's choices/limits**
  (main-session-only, system-prompt reconstruction + lost prompt-cache saving,
  unset-default, file-based `forkFrom` with the staleness caveat, print/headless and
  worktree deferrals, `run_in_background`-removal non-adoption). Cite ticket #28 and
  the Claude sub-agents docs.
- **Add a back-pointer at §2.6 (~`:243`)** where it says subagents "do not see
  conversation history": append "(except a fork — see §2.9)" so the sections don't
  contradict.

### Existing docs made stale by F16 (MUST update — verified by the docs review)

- **`doc/architecture.md:105-106`** — states dispatch uses "**not** the parent
  conversation". F16 makes this false. Update it (and the dispatch step at
  `~:214-216`) to note the `subagent_type:"fork"` exception. **Mandatory**, not
  conditional.
- **`doc/user-guide.md`** — the user-facing doc; update: `:23` ("fresh, isolated
  sessions" — add the fork caveat), the §4 dispatch discussion / `subagent_type`
  enumeration (~`:165-167`, add the `"fork"` type), the non-resumable list (~`:249-250`,
  add that `subagent_type:"fork"` is also non-resumable), and the §7 supported matrix
  (add the fork capability). Put the *actionable* bits (the env var, the unset default,
  the degrade) in prose a user actually reads — not only the one-line registry entry.
- **`README.md:52-62`** (Subagents bullet) — add a short fork clause; **disambiguate**
  from the Skills `context: fork` mention at `:51`.
- **`doc/design/pi-integration.md:39`** (and `:28`) — "Subagent runtime (fresh context
  … `SessionManager.inMemory()`)" — add a brief note that a fork uses
  `SessionManager.forkFrom(...)`, or accept as knowingly-minor and say so in the log.

### Generated matrix — `doc/supported-features.md`

Generated by `npm run gen:capabilities` (`package.json:54` → `scripts/gen-capability-matrix.mjs`).
The freshness guard (`test/registry.test.ts:446-456`, CRLF-normalized) fails if stale.
**Run `npm run gen:capabilities` after editing the registry** and commit the result;
never hand-edit it.

### CHANGELOG — `CHANGELOG.md`

Add under **`### Added`** in `[Unreleased]` (fork inheritance is a new capability;
follow the dated-subsection convention). The coordinator handles the serial-conflict
process at commit time.

## Writable surface

- `src/registry/capability-registry.ts`
- `doc/research/02-claude-code-internals.md`
- `doc/architecture.md`
- `doc/user-guide.md`
- `README.md`
- `doc/design/pi-integration.md`
- `doc/supported-features.md` (regenerated — do not hand-edit)
- `CHANGELOG.md`
- `test/registry.test.ts` (add the `tool.Agent.fork` lookup assertion)
- `doc/plan/16-subagent-fork-inheritance/log/t03.md`

## Approach constraints

- Registry note is a **single line**; verified vs INFERRED separated; tier **`partial`**.
- Describe the **actual enforced** behavior from t01/t02 — no over-promising. If t01/t02
  deviated, describe what shipped.
- Regenerate the matrix with `npm run gen:capabilities`; never hand-edit it.

## Left open

- Exact `§` number if 2.9 is taken — use the next free subsection and keep the registry
  reference in sync.
- Whether `pi-integration.md` gets a note or a logged accept-as-minor.

## Testing

- *Unit* (`test/registry.test.ts`): add a `lookupCapability("tool.Agent.fork")`
  assertion in the invariants block (mirroring `tool.Agent`/`tool.Task` at ~`:200-214`):
  tier `partial`, single-line note naming inheritance + env gate + non-resumable +
  no-nested-fork + main-session-only + system-prompt-reconstruction limit.
- The matrix-freshness guard (~`:446-456`) enforces regeneration — run
  `gen:capabilities` as the completeness gate.

Cross-platform: single-line registry note (CRLF-normalized matrix compare); no other
platform concerns.

## Acceptance criteria
- [ ] `tool.Agent.fork` exists at tier `partial` with a truthful single-line note and
      cross-references from `tool.Agent`/`tool.Task`/`feature.background-agents`;
      `tool.SendMessage` reworded.
- [ ] `doc/research/02-claude-code-internals.md` has a fork section the registry `§`
      resolves to, plus the §2.6 back-pointer.
- [ ] `doc/architecture.md`, `doc/user-guide.md`, `README.md` (and `pi-integration.md`
      or a logged accept) updated to remove/qualify now-stale "fresh context" claims.
- [ ] `doc/supported-features.md` regenerated via `npm run gen:capabilities`.
- [ ] CHANGELOG updated under `### Added`.
- [ ] `test/registry.test.ts` asserts the new entry; typecheck and full suite green.

## Depends on
t01, t02

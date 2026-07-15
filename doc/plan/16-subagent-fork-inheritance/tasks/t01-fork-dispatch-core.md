# t01: Fork dispatch core — parent-conversation inheritance, env gate, visible degrade

## Goal

Dispatching `subagent_type: "fork"` from the **main session** produces a subagent
whose session is **seeded with the parent conversation's full history** and runs
with the parent's **model** and **tools** and a **reconstructed same-context system
prompt**, while keeping **output isolation** (only the final message returns). The
feature is gated by `CLAUDE_CODE_FORK_SUBAGENT`. When inheritance cannot be honored
— gate off, no parent transcript, a **nested (non-main-session) dispatcher**, or the
SDK cannot fork — the dispatch **degrades visibly** to a fresh-context
general-purpose run with a **fork-specific notice** surfaced to *both* the fork and
the **developer** — never the generic "unknown subagent_type" warning, never
silently, never inheriting when disabled or nested.

(Fork-spawns-fork prevention is t02. The capability-registry/docs are t03. This task
must still leave the suite green.)

## Context & seams

All line numbers are approximate anchors in the current tree — locate by nearby code.

### The seeding mechanism

Pi ships `SessionManager.forkFrom(sourcePath, targetCwd, sessionDir?, options?)`
(`node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.d.ts:336`):
*"Creates a new session in the target cwd with the full history from the source
session."* It reads the parent transcript **file** and writes a **brand-new** file,
so the parent transcript is never touched. **Do NOT** reopen the parent transcript
in place via `reopenSessionManager` — it appends to the source file and would corrupt
the parent's conversation and leak the fork's steps onto the parent's on-disk history.

- **Add `forkSessionManager?()` to the `PiSdk` interface** (`src/runtime/subagents.ts:204-227`),
  shaped like `reopenSessionManager` (`:220-224`):
  `forkSessionManager?(sourcePath: string, cwd: string, sessionDir: string, id: string): PiSessionManagerLike;`
  Wire it in `loadRealSdk` (`:329-349`) to
  `m.SessionManager.forkFrom(sourcePath, cwd, sessionDir, { id })` — mirror the
  `reopenSessionManager` wiring at `:340-341`. Optional method (older/fake SDKs may
  lack it → "cannot fork" → visible degrade).

### Interception — before the unknown-type fallback, setting `resolved`

The `"fork"` literal is read as `opts.subagentType`; today it misses
`resolveAgentDefinition` and hits the **unknown-subagent-type fallback**
(`src/runtime/subagents.ts:622-637`), which runs general-purpose *fresh* with the
**generic** `unknown subagent_type "fork"; ran as general-purpose` warning + prefix
(`:632-636`) — the exact string the acceptance forbids. Interception rules:

- Detect the fork at `:622-637`, keyed on `requested === "fork"` **after**
  `resolveAgentDefinition` runs. `"fork"` is a **reserved** type: the interception
  wins even if a project defines an agent literally named `fork`.
- The interception MUST **short-circuit the `if (!resolved && agent)` block at
  `:631-637`** — i.e. set `resolved` to the synthetic fork agent (not just `agent`),
  or otherwise skip that block — so the generic unknown-type warning/prefix can
  never run for a fork.
- Compute a single per-dispatch boolean, **`isFork`** (true when this dispatch is a
  fork that will *actually inherit*, i.e. `requested === "fork"` AND inheritance is
  honored, not degraded). This is the named condition t02 threads into the fork's
  Agent/Task tools — keep it in scope at the `customToolsFor` call (`:986`). A
  **degraded** fork sets `isFork = false` (it is a plain fresh general-purpose run,
  so it must not carry the fork marker — otherwise its own nested dispatches would be
  mis-refused by t02).

### Synthetic fork agent (assigned locally, NOT via `opts.agentOverride`)

Build a synthetic `ClaudeAgent` for the fork the same way `forkDispatch` builds one
for `context:fork` skills (`src/index.ts:459-474`), but **assign it to the local
`resolved`/`agent`** — **do NOT set `opts.agentOverride`**. Rationale:
`overrideDispatch = opts.agentOverride !== undefined` (`:695`); keeping it `undefined`
(so `overrideDispatch` stays false) is required so the fork is not mistaken for a
skill override, and this task instead forces `resumable:false` explicitly (below).
The synthetic agent:
- `tools: undefined` ⇒ all-tools semantics (`ClaudeAgent.tools`, `src/types.ts:105`),
  through the existing `permissionEngine.gateTools(...)` / `customToolsFor` path
  (`:977-1001`). Because fork inheritance is restricted to the **main session**
  (below), all-tools correctly equals the main-session grant — no widening. Do NOT
  seed from `allKnownToolNames()` directly; go through the normal gate.
- `isolation: undefined` ⇒ the worktree-entry branch (`:935-951`) is skipped and the
  fork shares the parent cwd. (Worktree-isolated forks are out of scope — feature.md.)
- **Do not** route the fork through a `fork:<skill>` agentOverride identity (that is
  the *skill* `context:fork` feature — a different meaning of "fork").
- System prompt comes from the existing `deps.buildSystemPrompt(agent)` /
  `buildSubagentSystemPrompt` path (`src/index.ts:557,612-624`) — the same
  project-CLAUDE.md/rules/skills/memory/steering reconstruction, neutral persona.

### Model — inherited, with the operator override respected

Pass no model spec; `resolveModel(undefined)` returns the parent's live
`currentModel` (`src/index.ts:536-537`, kept current at `:1075-1076`,`:1366-1367`).
Note: the existing `CLAUDE_CODE_SUBAGENT_MODEL` rung sits **above** the inherited
model in resolution (`:1025-1028`). Decision: **leave that as-is** — a fork inherits
the parent's model by default, but an operator who set `CLAUDE_CODE_SUBAGENT_MODEL`
still overrides it (least surprise for that operator; documented in t03's registry
note). Do not add fork-specific model code.

### Env gate — `CLAUDE_CODE_FORK_SUBAGENT`, from `process.env` ONLY

Read at dispatch time from `process.env` (posture of the existing gates
`CLAUDE_CODE_SUBAGENT_MODEL` `:1025`, `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS` `:1668`).
Reuse `isEnvTruthy` (`:376-380`). Semantics:
- `=1`/truthy ⇒ on. `=0`/present-but-off ⇒ off ⇒ visible degrade.
- **unset ⇒ ENABLED** (distinguish present-but-off from absent). PiCC parity choice.
- **SECURITY invariant (state in a comment):** sourced from `process.env` ONLY —
  never `project.settings.env`, frontmatter, or any project file (a project could
  otherwise force-enable inheritance of its own dispatches).

### Main-session-only inheritance (SECURITY — prevents root-conversation exfiltration)

`getMainSessionFile()` (`:1053`, wired to `src/index.ts:248-254,727`) **always**
returns the **main/root** session transcript, regardless of which agent dispatches.
So a fork dispatched from a nested subagent would `forkFrom` the **root** conversation
— the wrong conversation, and an **exfiltration path**: a tool-restricted subagent
could fork the root conversation (secrets/tokens/file contents) into itself. Guard:

- **Honor fork inheritance only when the dispatcher is the main session.** Verify the
  exact depth convention against the code (the main session's Agent/Task tools
  dispatch at depth 0→1, `src/index.ts:893-894`, so a main-session dispatch has
  `opts.depth === 1`). For any deeper dispatcher (`opts.depth > 1`), **do NOT** seed
  from `getMainSessionFile()` — visible-degrade with a specific
  "parent conversation not available for a nested fork" notice.
- t02 additionally blocks a *fork* from spawning a fork; this depth rule is the
  broader bound covering *any* nested dispatcher (normal subagent → fork included).

### Session-manager construction — the third branch

Two existing branches feed `sessionManager` into `sessionOptions`
(`:1131-1142`) → `sdk.createAgentSession`: resume/reopen (`:1057-1102`) and
fresh-persist (`:1103-1128`). Add a **third, fork branch**, entered only when the
fork will actually inherit (main-session dispatcher, gate on, transcript present,
`forkSessionManager` present):
- Build via `sdk.forkSessionManager(getMainSessionFile(), cwd,
  subagentSessionDir(mainSessionFile), agentId)`; read the real path back with
  `manager.getSessionFile()` (as `:1083`/`:1110` do) **for `transcriptPath` only** —
  do NOT compute `resumable` from it.
- **Force `resumable = false` for the fork in TWO places:** (1) the register
  site(s) (`:1152-1165`, alongside the `overrideDispatch ? false : resumable` gate at
  `:1162` — extend it with the `isFork` predicate) AND (2) every **returned**
  `DispatchResult` for the fork (the results at `:1227`,`:1244`,`:1310`,`:1351`,
  and the success path, use the raw local `resumable`, which is never re-gated by
  `overrideDispatch`). Set the fork's local `resumable = false` so both the registry
  record and the returned result agree — otherwise the model is told a fork is
  resumable (resume trailer, `presentDispatchResult` `:1516/:1765`) while the registry
  refuses it. Mirror the MUST-FIX #1 rationale (`:1159-1161`,`:688-695`) on an
  `isFork` predicate.
- SendMessage-resume must refuse a fork via the existing non-resumable path. Its
  current refusal text (`:1935`, "ran without a persisted transcript") would be
  *misleading* for a fork that persists a transcript but is forced non-resumable —
  give the fork case a truthful refusal reason (e.g. "a fork's inherited context
  cannot be re-derived; not resumable"). Tests assert refusal *occurs*, not the exact
  sentence.

### Visible degrade — reach the developer, not just the model and logs

The existing degrade pattern (diagnostic + prompt prefix, `:632-636`) is
**model-facing + logs only**: the prompt prefix lands in the subagent's input, and a
`diagnostics`/`details` entry is **not** read by `renderAgentResult`
(`src/runtime/subagent-render.ts:252-431`). So "visible to the developer" is not
achieved by those two channels alone. Requirements:
- **Model-facing:** prefix the fork's prompt with a fork-specific note (so it doesn't
  answer as if it inherited) — as `:636` does, but fork-specific wording, sanitized
  via SEC-2 (`subagent-render.ts:153-154`) if it embeds any variable text.
- **Developer-facing:** surface the degrade in the rendered result — add a muted
  **footer line** in `renderAgentResult` (same slot as the `resumable via SendMessage`
  hint at `subagent-render.ts:418-424`) naming why the fork ran fresh, AND make the
  **badge honest**: a *successful* inherited fork should render an identity that
  reads as a fork (e.g. `Agent(fork) completed`), a *degraded* one as the
  fresh-agent identity — so success vs. degrade are distinguishable (today
  `renderAgentCall` prints `Agent(fork)` from the raw arg `:222-224` while
  `renderAgentResult` badges `details.agent`=`agentName` `:367`; pick the fork's
  `agentName`/badge so the two lines tell the truth).
- **Tone:** calm/`info` for expected cases — env `=0` opt-out and (t02) the
  fork-spawns-fork refusal; `warning` only for genuine can't-do — no parent
  transcript, SDK lacks `forkSessionManager`, `forkFrom` threw. (Mirrors F15's
  precedent that a user-requested degrade is a calm note, not a warning —
  `test/background-tasks.test.ts:946`.)
- **Actionable text:** the `=0` notice names the variable and the fix
  ("fork inheritance disabled via `CLAUDE_CODE_FORK_SUBAGENT=0`; unset it to enable").
- **Background surface:** a `"fork"` dispatch is background-by-default under F15
  (`:1679-1687`), so the developer-facing notice must reach the surface a backgrounded
  dispatch uses (TaskOutput / result rendering), not only an inline path — the
  degrade tests target that surface.

### Degrade trigger list (all → fresh general-purpose, specific notice, NEVER the generic warning, NEVER inheriting)

(i) gate `=0`; (ii) `getMainSessionFile()` undefined (print/RPC/no-session — check at
the top of the fork branch before touching the SDK); (iii) dispatcher is nested
(`opts.depth > 1`); (iv) `sdk.forkSessionManager` absent; (v) `forkFrom` throws. Each
runs a normal fresh general-purpose dispatch through the **normal gate** (fail-open to
fresh context is acceptable; fail-open to inherited context is NOT).

### Output isolation & no-leakage

Only the fork's final assistant message returns (verbatim-return contract unchanged).
Keep the inherited parent history OUT of hook payloads, diagnostics, logs, render: the
fork's `SubagentStart`/`SubagentStop` hook `prompt` field (`:902-910`) carries the
**task text only**, never inherited history. Permission engine unchanged (`:977-1001`,
no lighter fork path); route the fork through the normal Agent-tool `execute` (`:1660`)
so `deny: Agent(fork)` (`src/engine/permissions.ts:573-575`) is honored first.

## Writable surface

- `src/runtime/subagents.ts`
- `src/runtime/subagent-render.ts` (footer line + honest fork badge)
- `src/index.ts` (only if the synthetic fork-agent construction / buildSystemPrompt
  wiring needs a small hook; keep minimal)
- `test/helpers/fake-sdk.ts` (real+fake `forkSessionManager`, seed pre-population)
- New/extended tests: `test/fork-inheritance.test.ts`, plus additions to
  `test/runtime-core.test.ts`, `test/subagent-transcripts.test.ts`
- `doc/plan/16-subagent-fork-inheritance/log/t01.md`

Everything else read-only.

## Approach constraints

- Reuse native `SessionManager.forkFrom`; never reopen the parent transcript in place.
- Fork agent is assigned **locally**; `opts.agentOverride` stays undefined;
  `resumable:false` forced at both register site and returned result.
- Interception sets `resolved` so the generic unknown-type warning cannot fire.
- Fork inheritance honored only for the **main-session** dispatcher.
- Env gate read from `process.env` only.
- The developer-facing degrade must reach a channel the developer actually sees.

## Left open

- Exact synthetic fork-agent name/persona and the fork **badge** label (must make
  success vs. degrade distinguishable and read as a fork on success).
- Exact notice wording per trigger (specific, single-sentence-ish, distinct from the
  generic unknown-type warning; calm vs. warning tone per the rules above).
- Whether the fork records a persisted transcript vs. in-memory — decide and
  **assert** it (default: persisted child file, forced non-resumable).
- **`forkFrom` staleness** (the fork runs mid-parent-turn; the triggering exchange
  may be unflushed, so `forkFrom` inherits up to the last *completed* turn): accept
  file-based `forkFrom` here; leave the live-`buildSessionContext()` escape hatch
  unimplemented. The coordinator verifies empirically (Phase 8/verify) whether
  staleness bites; if so, a follow-up widens deps to read the live leaf.

## Testing

Extend `test/helpers/fake-sdk.ts` (do not fork the helper):
- Add `forkSessionManager` to BOTH the fake SDK and the **real**-SessionManager seam
  (`RealSessionManager` + `useRealSessionManager`, wired conditionally exactly like
  `persistedSessionManager`/`reopenSessionManager` at `test/helpers/fake-sdk.ts:260-269`),
  so a test can exercise the genuine `SessionManager.forkFrom`.
- Make the fake `createAgentSession` **pre-populate `state.messages` from the seed**
  (via the fork manager's `buildSessionContext().messages`, or a captured seed field)
  and record an inheritance flag, so "fresh vs fork" is a one-line differential.

Cover (layer noted):
- **Genuine inherit (primary proof)** — *real-SM* in `test/subagent-transcripts.test.ts`
  (already `useRealSessionManager` at `:29`): seed a real parent transcript with a
  unique token, dispatch `subagentType:"fork"` from a main-session (depth-1) dispatch,
  reopen the fork's own file, assert the token is present. The stub-based unit test is
  a *supplementary* wiring check, not the primary proof.
- **Parent transcript file unchanged** — *real-SM*: read the parent transcript's
  message count/content before and after the fork; assert equality (catches an
  accidental reopen-in-place). Asserting only the in-memory parent object is
  insufficient (trivially true).
- **Output isolation** — *unit*: fork scripted with intermediate turns;
  `finalMessage` is the verbatim last assistant message only; the parent session
  object is not mutated.
- **Same tools/model, not a `fork:<skill>` override** — *unit*: assert
  `h.created[i].tools`/`.customTools`/`.model` match the parent/session grants, and
  the created session's system prompt/agentName is the neutral reconstruction, **not**
  a `fork:<skill>` string (name the concrete observable, e.g. the `SYSTEM:${name}`
  the fake `buildSystemPrompt` returns).
- **System-prompt reconstruction** — *offline* (real `picc()` + fixture CLAUDE.md):
  assert the fork's system prompt includes project-derived content (proves the
  same-context reconstruction, not an empty/agent persona). If too costly, keep the
  registry claim as the honest "reconstruction" caveat (t03) rather than a promise.
- **`CLAUDE_CODE_FORK_SUBAGENT=0` → fresh + specific notice** — *unit*, env
  save/restore (`prev===undefined?delete:restore`, `test/runtime-core.test.ts:750,783`):
  fresh context (no seeded messages), the **specific** fork notice present (calm
  tone), and the generic `unknown subagent_type "fork"; ran as general-purpose` string
  **absent**.
- **Unset default → enabled** — *unit*: env var deleted ⇒ inheritance occurs, no
  fork-unavailable notice.
- **No-parent-transcript degrade** — *unit*: `getMainSessionFile()` undefined ⇒ fresh
  + specific notice (warning tone), not the generic warning.
- **Nested-dispatcher degrade** — *unit* (or offline): a `depth > 1` fork dispatch
  degrades to fresh with the "nested fork" notice and does **not** seed from the main
  transcript.
- **Missing `forkSessionManager`** and **`forkFrom` throws** — *unit*: each degrades
  to fresh + specific notice (warning tone), not a rejected dispatch, not the generic
  warning.
- **No leakage into hooks** — *unit*: the fork's `SubagentStart` payload `prompt`
  equals the task text and does NOT contain the parent's unique token (capture via the
  `FakeHookRunner`).
- **Non-resumable** — *unit* (`test/subagent-transcripts.test.ts`): a `"fork"` dispatch
  reports `resumable:false` in the **returned result** (not just the registry); assert
  the persisted-transcript posture explicitly; SendMessage refuses it (assert refusal
  occurs, don't pin the sentence).
- **Developer-facing degrade rendering** — *unit* against `renderAgentResult`: a
  degraded fork renders the muted footer line / honest badge; a successful fork badge
  reads as a fork. (If backgrounded, target the TaskOutput/result surface.)

Cross-platform: `process.env` is global within a file — save/restore in `finally`.
On-disk fork tests use `subagentSessionDir()`/`resolveSubagentTranscript` (Windows
-tested) and the `fs.rmSync(..., { maxRetries: 5, retryDelay: 100 })` cleanup idiom;
dispose the parent manager before the fork reads where a lock could bite. Reuse
`isEnvTruthy` off-set semantics so `=0`/`=off` behave identically across shells.

## Acceptance criteria
- [ ] A main-session `subagent_type: "fork"` seeds the fork with the parent
      transcript's full history via `SessionManager.forkFrom`, without modifying the
      parent transcript (proven at the real-SM layer).
- [ ] Fork uses the parent's model (operator `CLAUDE_CODE_SUBAGENT_MODEL` override
      respected) and tools and a reconstructed same-context system prompt — not an
      agent-definition persona, not a `fork:<skill>` override.
- [ ] Output isolation preserved; parent session and transcript unmodified.
- [ ] Every degrade trigger (env `=0`, no transcript, nested dispatcher, missing
      `forkSessionManager`, `forkFrom` throw) runs fresh with a **fork-specific**
      notice — never the generic unknown-type warning, never silent, never inheriting
      — and the interception sets `resolved` so the generic warning cannot fire.
- [ ] The degrade is visible to the **developer** (footer/badge), toned calm for
      expected cases and warning for can't-do cases; success vs. degrade are
      distinguishable.
- [ ] Unset env defaults to enabled; gate read from `process.env` only.
- [ ] Fork is `resumable:false` in both the registry record and the returned result;
      SendMessage refuses it cleanly with a truthful reason.
- [ ] typecheck and full test suite green

## Depends on
–

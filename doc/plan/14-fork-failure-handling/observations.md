# F14 observations

Running record of friction, bugs, and opportunities. Dated bullets; raw material for review.md.

## 2026-07-14 — from Phase 6 plan review (deferred / out of scope)

- **[deferred] Typed `/forked-skill` Esc non-cancellability has no point-of-use signal.**
  The gap is disclosed only in the capability registry / `/compat` surface, not where the
  user presses Esc. Accepted as a documented residual for F14 (the runtime fix would need a
  Pi-base change to expose an abort signal to input hooks, or to move fork expansion into the
  turn). Candidate follow-up: surface a subtle non-cancellable hint, or push Pi to expose the
  signal. (generalist SHOULD3, docs SHOULD.)
- **[deferred] Nested-fork / from-subagent Esc *delivery* is unverified.** F14 threads the
  abort signal correctly at each hop, but whether a genuine top-level Esc is delivered to a
  *nested* Skill `execute` inside a subagent is Pi's cross-session abort-propagation
  behaviour, not tested here. Same class as any nested tool. Worth a dedicated
  propagation test / Pi-behaviour confirmation later. (generalist SHOULD1, tester residual.)
- **[deferred] `examples/full-surface` has no executable fork failure/Esc conformance
  statement.** `fork-research` exists and is used by the offline tests, but the supported
  surface isn't exercised as a conformance fixture for failure/abort. Same family as F02
  follow-up 7 (background:true / SendMessage fixture). (claude-parity SHOULD.)
- **[pre-existing, not F14] Agent-tool aborted path discards partial output.** F14 matches
  this for parity, but whether discarding partial-on-abort itself matches Claude Code (which
  tends to leave interrupted partial content visible) is an open Agent-path question F14
  deliberately does not reopen. (claude-parity, generalist.)
- **[pre-existing, not F14] `skill.name` interpolated into input-hook transform text**
  (`index.ts:1046`, kept in the F14 rewording). If the skill loader does not strip
  newlines/control chars from a frontmatter `name`, a malicious project skill could inject
  lines into the user turn. Loader-side check, out of F14 scope. (security NIT.)
## 2026-07-14 — t01 (dispatch-presentation helper)

- Refactor was byte-identical; both reviewers (coder, tester) confirmed behaviour-preservation
  via the unchanged Agent-tool regression suites. +21 unit tests.
- Coupling NIT taken: the Agent-tool consumer re-derives the cut-off case via
  `result.outcome === "failed"`, an invariant the helper owns. Added an explicit comment tying
  the two together so a future change to the helper's branch guard won't silently misroute.

## 2026-07-14 — t02 (wire fork path)

- All four reviewers (coder, security, claude-parity, tester) PASS, no MUST/SHOULD fixes.
  Security confirmed the sdk-seam has no env/settings/file fallback and the abort threading
  adds no listener surface; tester confirmed the abort test genuinely proves signal threading
  (never-resolving gate would hang, not pass, if threading were dropped).
- sdk-seam shape: `PiccTestSeam.sdk?: PiSdk`, conditional-spread into `new SubagentRuntime`
  deps at construction (NOT onWired). Guarded by test/fork-sdk-seam.test.ts (single-arg
  picc(pi) ⇒ loadRealSdk, via a partial vi.mock of the real module).
- Took two tester NITs: assert `details.agent` presence on success + partial paths; clarifying
  comment on why fork cutOff is always false (non-resumable). Skipped: adding
  `details.outcome`/`details.error` to Skill-fork failed-partial details (logs-only, never
  model-visible, no consumer needs it — model-visible content is byte-identical to Agent tool).
- **[for t03]** parity reviewer confirmed the registry note must say F14 *threads* the Esc
  signal to the Skill-tool fork (verified), NOT that "Esc cancels a nested fork" (cross-session
  delivery is Pi's, unverified); typed /forked-skill stays non-cancellable (harness limit).

## Phase-6 deferred (continued)

- **[note] `capErrorText` is duplicated on purpose** in `background-tasks.ts:416-423` to avoid
  a value-level import cycle. t01's "one source of truth" is scoped to the presentation path
  and must not touch that mirror. (generalist SHOULD2.)
